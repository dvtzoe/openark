import type { AgentManifest, ModuleContext, OpenArkModule } from "./types.js";
import type { ServiceLike } from "./types.js";

export type RuntimeLogger = (level: "info" | "warn" | "error", message: string) => void;

export type Runtime = {
  agent(): string;
  manifest(): AgentManifest | null;
  active(): OpenArkModule[];
  ctx(): ModuleContext | null;
  switchAgent(name: string): Promise<void>;
  onUserMessage(text: string): Promise<void>;
  onToolResult(result: {
    tool: string;
    ok: boolean;
    durationMs: number;
    summary: string;
  }): Promise<void>;
  onSessionEnd(): Promise<void>;
  injections(sessionID?: string): Promise<string>;
  enabledModules(): string[];
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

export async function createRuntime(deps: RuntimeDeps): Promise<Runtime> {
  const loaded = new Map<string, Loaded>();
  let current: Loaded | null = null;

  async function loadAgent(name: string): Promise<Loaded | null> {
    if (loaded.has(name)) return loaded.get(name) ?? null;
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
      deps.log("warn", `agent "${name}" unavailable: ${String(err)}`);
      return null;
    }
  }

  current = await loadAgent(deps.defaultAgent);

  return {
    agent: () => current?.agent ?? deps.defaultAgent,
    manifest: () => current?.ctx.manifest ?? null,
    active: () => current?.active ?? [],
    ctx: () => current?.ctx ?? null,

    async switchAgent(name: string) {
      if (!name || name === current?.agent) return;
      if (current) await flush(current);
      current = await loadAgent(name);
    },

    async onUserMessage(text: string) {
      if (!current) return;
      for (const mod of current.active) {
        await mod.onUserMessage?.(current.ctx, { role: "user", text });
      }
    },

    async onToolResult(result) {
      if (!current) return;
      for (const mod of current.active) {
        await mod.onToolResult?.(current.ctx, result);
      }
    },

    async onSessionEnd() {
      if (current) await flush(current);
    },

    async injections(sessionID?: string) {
      if (!current) return "";
      if (sessionID) {
        current.ctx.session = { id: sessionID };
      } else {
        current.ctx.session = undefined;
      }
      return deps.collectInjections(current.active, current.ctx);
    },

    enabledModules: () => current?.active.map((m) => m.name) ?? [],
  };
}

async function flush(entry: Loaded): Promise<void> {
  try {
    for (const mod of entry.active) {
      await mod.onSessionEnd?.(entry.ctx);
    }
  } catch (err) {
    entry.ctx.log("warn", `session flush failed: ${String(err)}`);
  }
}
