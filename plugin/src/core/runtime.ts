import { ServiceError } from "./service.js";
import type { AgentManifest, ModuleContext, OpenArkModule } from "./types.js";
import type { ServiceLike } from "./types.js";

export type RuntimeLogger = (level: "info" | "warn" | "error", message: string) => void;

export type Runtime = {
  agent(sessionID?: string): string;
  manifest(sessionID?: string): AgentManifest | null;
  active(sessionID?: string): OpenArkModule[];
  ctx(sessionID?: string): ModuleContext | null;
  noteSession(sessionID: string, agent: string, model?: string): Promise<void>;
  forgetSession(sessionID: string): void;
  onUserMessage(sessionID: string, text: string): Promise<void>;
  onToolResult(
    sessionID: string,
    result: { tool: string; ok: boolean; durationMs: number; summary: string },
  ): Promise<void>;
  onSessionEnd(sessionID?: string): Promise<void>;
  injections(sessionID?: string): Promise<string>;
  enabledModules(sessionID?: string): string[];
};

export type RuntimeDeps = {
  defaultAgent: string;
  service: ServiceLike;
  loadModules(ctx: ModuleContext): Promise<OpenArkModule[]>;
  collectInjections(active: OpenArkModule[], ctx: ModuleContext): Promise<string>;
  log: RuntimeLogger;
  directory?: string;
};

type Loaded = {
  agent: string;
  ctx: ModuleContext;
  active: OpenArkModule[];
};

// opencode's built-in agents are never openark agents — skip the service
// entirely for them (no fetch, no log) and treat their sessions as a
// passthrough no-op. Anything else that 404s joins `unavailable` below.
const NATIVE_PASSTHROUGH = new Set(["build", "plan"]);

function isNotFound(err: unknown): boolean {
  // Strict: only a real 404 from the service means "not an openark agent".
  // Substring matching used to cache transient errors (or any text that
  // happened to mention "404") as permanently unavailable.
  return err instanceof ServiceError && err.status === 404;
}

// Every session gets its own ModuleContext (built fresh per call by
// withSession below) so that concurrent sessions on different agents can
// never observe or mutate each other's state — see docs/plans/
// 0003-findings-plugin-modules.md #1b for the cross-session race this
// replaces (a single shared "current agent" pointer).
export async function createRuntime(deps: RuntimeDeps): Promise<Runtime> {
  const loaded = new Map<string, Loaded>();
  const sessionAgent = new Map<string, string>();
  // Agents the service answered 404 for (plus the native passthroughs
  // above): known-not-openark, so later sessions skip the fetch instead
  // of paying one 404 + one warn line per session first turn. Only 404s
  // are cached here — transient errors (service down) retry next time.
  const unavailable = new Set<string>(NATIVE_PASSTHROUGH);
  // The model selected in the TUI for a session, forwarded to the service
  // so background LLM tasks (extraction, reflection, persona updates) have
  // a route even when opencode has no small_model configured.
  const sessionModels = new Map<string, string>();
  // Which (session, agent) pairs have already had their "session start"
  // manifest read. MODULE_SPEC.md promises the manifest is re-read (so a
  // module toggle takes effect) at session start, not cached for the whole
  // plugin process — see docs/plans/0003-findings-plugin-core.md #2.
  const sessionSeenAgents = new Map<string, Set<string>>();

  function baseCtx(name: string, manifest: AgentManifest): ModuleContext {
    return {
      agent: name,
      manifest,
      service: deps.service,
      log: deps.log,
      directory: deps.directory,
    };
  }

  function announce(entry: Loaded): void {
    const names = entry.active.map((m) => m.name).join(", ") || "none";
    deps.log("info", `agent "${entry.agent}" loaded modules: ${names}`);
  }

  async function fetchAgent(name: string): Promise<Loaded | null> {
    try {
      const manifest = await deps.service.getJSON<AgentManifest>(`/v1/agents/${name}`);
      const ctx = baseCtx(name, manifest);
      const active = await deps.loadModules(ctx);
      return { agent: name, ctx, active };
    } catch (err) {
      if (isNotFound(err)) {
        // Not an openark agent (e.g. opencode's native build/plan): quiet
        // passthrough, cached so the next session doesn't pay another 404.
        unavailable.add(name);
        deps.log("info", `agent "${name}" is not an openark agent — passthrough (no modules)`);
        return null;
      }
      deps.log("warn", `agent "${name}" unavailable: ${String(err)}`);
      return null;
    }
  }

  async function loadAgent(name: string): Promise<Loaded | null> {
    if (loaded.has(name)) return loaded.get(name) ?? null;
    if (unavailable.has(name)) return null;
    const entry = await fetchAgent(name);
    if (entry) {
      loaded.set(name, entry);
      announce(entry);
    }
    return entry;
  }

  let defaultLoaded = await loadAgent(deps.defaultAgent);

  function resolve(sessionID?: string): Loaded | null {
    if (sessionID && sessionAgent.has(sessionID)) {
      // Explicitly noted session: an unknown agent is a deliberate
      // passthrough no-op — never fall back to the default agent's
      // persona/modules (that would inject defoko into build sessions).
      const name = sessionAgent.get(sessionID) as string;
      return loaded.get(name) ?? null;
    }
    return defaultLoaded;
  }

  function withSession(entry: Loaded, sessionID?: string): ModuleContext {
    const model = sessionID ? sessionModels.get(sessionID) : undefined;
    const service = model && deps.service.withModel ? deps.service.withModel(model) : deps.service;
    return {
      ...entry.ctx,
      service,
      session: sessionID ? { id: sessionID, model } : undefined,
    };
  }

  return {
    agent: (sessionID) => {
      if (sessionID && sessionAgent.has(sessionID)) return sessionAgent.get(sessionID) as string;
      return resolve(sessionID)?.agent ?? deps.defaultAgent;
    },
    manifest: (sessionID) => resolve(sessionID)?.ctx.manifest ?? null,
    active: (sessionID) => resolve(sessionID)?.active ?? [],
    ctx: (sessionID) => {
      const entry = resolve(sessionID);
      return entry ? withSession(entry, sessionID) : null;
    },
    enabledModules: (sessionID) => resolve(sessionID)?.active.map((m) => m.name) ?? [],

    async noteSession(sessionID, agentName, model) {
      if (!agentName) return;
      sessionAgent.set(sessionID, agentName);
      if (model) sessionModels.set(sessionID, model);
      const seen = sessionSeenAgents.get(sessionID) ?? new Set<string>();
      if (seen.has(agentName)) return;
      seen.add(agentName);
      sessionSeenAgents.set(sessionID, seen);
      // Known non-openark agent (native build/plan or a previous 404):
      // nothing to refresh, don't pay another fetch per session.
      if (unavailable.has(agentName)) return;
      // Session-start manifest refresh: fetch the replacement first and
      // swap it in only on success, so a concurrent session never resolves
      // to null mid-reload and a transient failure keeps the old entry.
      const previous = loaded.get(agentName);
      const fresh = await fetchAgent(agentName);
      if (fresh) {
        loaded.set(agentName, fresh);
        if (agentName === deps.defaultAgent) defaultLoaded = fresh;
        announce(fresh);
      } else if (unavailable.has(agentName)) {
        // The agent was deleted (or never existed): drop the cached entry.
        loaded.delete(agentName);
        if (agentName === deps.defaultAgent) defaultLoaded = null;
      } else if (previous) {
        loaded.set(agentName, previous);
      }
    },

    forgetSession(sessionID) {
      const agentName = sessionAgent.get(sessionID);
      sessionAgent.delete(sessionID);
      sessionSeenAgents.delete(sessionID);
      sessionModels.delete(sessionID);
      const entry = agentName ? loaded.get(agentName) : undefined;
      if (!entry) return;
      const ctx = withSession(entry, sessionID);
      for (const mod of entry.active) {
        try {
          mod.onSessionDeleted?.(ctx);
        } catch (err) {
          deps.log("warn", `module ${mod.name} session cleanup failed: ${String(err)}`);
        }
      }
    },

    async onUserMessage(sessionID, text) {
      const entry = resolve(sessionID);
      if (!entry) return;
      const ctx = withSession(entry, sessionID);
      for (const mod of entry.active) {
        try {
          await mod.onUserMessage?.(ctx, { role: "user", text });
        } catch (err) {
          deps.log("warn", `module ${mod.name} onUserMessage failed: ${String(err)}`);
        }
      }
    },

    async onToolResult(sessionID, result) {
      const entry = resolve(sessionID);
      if (!entry) return;
      const ctx = withSession(entry, sessionID);
      for (const mod of entry.active) {
        try {
          await mod.onToolResult?.(ctx, result);
        } catch (err) {
          deps.log("warn", `module ${mod.name} onToolResult failed: ${String(err)}`);
        }
      }
    },

    async onSessionEnd(sessionID) {
      if (sessionID) {
        const entry = resolve(sessionID);
        if (entry) await flush(entry, withSession(entry, sessionID));
        sessionAgent.delete(sessionID);
        sessionSeenAgents.delete(sessionID);
        sessionModels.delete(sessionID);
        return;
      }
      // No sessionID means the whole plugin process is shutting down
      // (opencode's `dispose` hook): flush every session still tracked,
      // each against its own agent, instead of guessing at one "current".
      for (const [sid, agentName] of sessionAgent) {
        const entry = loaded.get(agentName);
        if (entry) await flush(entry, withSession(entry, sid));
      }
      sessionAgent.clear();
      sessionSeenAgents.clear();
      sessionModels.clear();
    },

    async injections(sessionID) {
      const entry = resolve(sessionID);
      if (!entry) return "";
      return deps.collectInjections(entry.active, withSession(entry, sessionID));
    },
  };
}

async function flush(entry: Loaded, ctx: ModuleContext): Promise<void> {
  for (const mod of entry.active) {
    try {
      await mod.onSessionEnd?.(ctx);
    } catch (err) {
      // Per-module isolation: one failing module must not skip the rest.
      ctx.log("warn", `module ${mod.name} session flush failed: ${String(err)}`);
    }
  }
}
