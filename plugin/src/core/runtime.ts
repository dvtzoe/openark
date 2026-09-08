import type { AgentManifest, ModuleContext, OpenArkModule } from "./types.js";
import type { ServiceLike } from "./types.js";

export type RuntimeLogger = (level: "info" | "warn" | "error", message: string) => void;

export type Runtime = {
  agent(sessionID?: string): string;
  manifest(sessionID?: string): AgentManifest | null;
  active(sessionID?: string): OpenArkModule[];
  ctx(sessionID?: string): ModuleContext | null;
  noteSession(sessionID: string, agent: string): Promise<void>;
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
  if (typeof err === "object" && err !== null && "status" in err) {
    if ((err as { status?: unknown }).status === 404) return true;
  }
  const text = String(err);
  return text.includes("404") || text.includes("no such agent") || text.includes("not found");
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
  // Which (session, agent) pairs have already had their "session start"
  // manifest read. MODULE_SPEC.md promises the manifest is re-read (so a
  // module toggle takes effect) at session start, not cached for the whole
  // plugin process — see docs/plans/0003-findings-plugin-core.md #2.
  const sessionSeenAgents = new Map<string, Set<string>>();

  async function loadAgent(name: string): Promise<Loaded | null> {
    if (loaded.has(name)) return loaded.get(name) ?? null;
    if (unavailable.has(name)) return null;
    try {
      const manifest = await deps.service.getJSON<AgentManifest>(`/v1/agents/${name}`);
      const ctx: ModuleContext = {
        agent: name,
        manifest,
        service: deps.service,
        log: deps.log,
      };
      const active = await deps.loadModules(ctx);
      const entry = { agent: name, ctx, active };
      loaded.set(name, entry);
      const names = active.map((m) => m.name).join(", ") || "none";
      deps.log("info", `agent "${name}" loaded modules: ${names}`);
      return entry;
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

  const defaultLoaded = await loadAgent(deps.defaultAgent);

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
    return { ...entry.ctx, session: sessionID ? { id: sessionID } : undefined };
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

    async noteSession(sessionID, agentName) {
      if (!agentName) return;
      sessionAgent.set(sessionID, agentName);
      const seen = sessionSeenAgents.get(sessionID) ?? new Set<string>();
      if (!seen.has(agentName)) {
        seen.add(agentName);
        sessionSeenAgents.set(sessionID, seen);
        loaded.delete(agentName);
      }
      await loadAgent(agentName);
    },

    forgetSession(sessionID) {
      sessionAgent.delete(sessionID);
      sessionSeenAgents.delete(sessionID);
    },

    async onUserMessage(sessionID, text) {
      const entry = resolve(sessionID);
      if (!entry) return;
      const ctx = withSession(entry, sessionID);
      for (const mod of entry.active) {
        await mod.onUserMessage?.(ctx, { role: "user", text });
      }
    },

    async onToolResult(sessionID, result) {
      const entry = resolve(sessionID);
      if (!entry) return;
      const ctx = withSession(entry, sessionID);
      for (const mod of entry.active) {
        await mod.onToolResult?.(ctx, result);
      }
    },

    async onSessionEnd(sessionID) {
      if (sessionID) {
        const entry = resolve(sessionID);
        if (entry) await flush(entry, withSession(entry, sessionID));
        sessionAgent.delete(sessionID);
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
    },

    async injections(sessionID) {
      const entry = resolve(sessionID);
      if (!entry) return "";
      return deps.collectInjections(entry.active, withSession(entry, sessionID));
    },
  };
}

async function flush(entry: Loaded, ctx: ModuleContext): Promise<void> {
  try {
    for (const mod of entry.active) {
      await mod.onSessionEnd?.(ctx);
    }
  } catch (err) {
    ctx.log("warn", `session flush failed: ${String(err)}`);
  }
}
