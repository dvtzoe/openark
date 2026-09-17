import type { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { readGlobalConfig, resolveAgentName, serviceBaseUrl } from "./core/config.js";
import { registerHooks } from "./core/hooks.js";
import { ensureService } from "./core/lifecycle.js";
import { collectInjections, collectToolSpecs, loadModules } from "./core/loader.js";
import { createPluginLogger } from "./core/log.js";
import { createRuntime } from "./core/runtime.js";
import type { Runtime } from "./core/runtime.js";
import { ServiceClient } from "./core/service.js";
import type {
  AgentManifest,
  ModuleContext,
  ModuleTool,
  ServiceLike,
  ToolExecuteContext,
} from "./core/types.js";

// Never console.* in the plugin runtime — the opencode TUI owns stdio
// and any write paints over it. All plugin logs go to
// ~/.openark/logs/plugin.log via createPluginLogger (stderr mirror only
// when OPENARK_DEBUG=1).

// Tool names/descriptions are the same for every agent (they come from the
// module's own code, not agent state), so they're enumerated once here to
// register with opencode. Each tool's `execute`, however, re-resolves the
// calling session's actual agent on every invocation (see toolsFor) instead
// of closing over the ctx captured at this enumeration — otherwise every
// tool call would silently operate on whichever agent happened to be
// loaded first, regardless of which agent the calling session has active.
// See docs/plans/0003-findings-plugin-modules.md #1b.
function toolsFor(runtime: Runtime, sessionID: string | undefined): ModuleTool[] {
  const ctx = runtime.ctx(sessionID);
  if (!ctx) return [];
  const seen = new Set<string>();
  const tools: ModuleTool[] = [];
  for (const mod of runtime.active(sessionID)) {
    for (const t of mod.tools?.(ctx) ?? []) {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      tools.push(t);
    }
  }
  return tools;
}

async function registerTools(
  ctx: Plugin.Context,
  runtime: Runtime,
  service: ServiceLike,
  log: (level: "info" | "warn" | "error", message: string) => void,
): Promise<void> {
  // Registration must not depend on the default agent's module toggles or
  // on the service being up at plugin init (the execute wrapper below
  // re-resolves the calling session's live agent/modules anyway). Tools are
  // built against a bootstrap context; their execute closures are never
  // called from here.
  const agent = runtime.agent();
  const manifest: AgentManifest = {
    name: agent,
    description: "",
    modules: {},
    channels: { subscriptions: [] },
  };
  const moduleCtx: ModuleContext = { agent, manifest, service, log };
  const startup = collectToolSpecs(moduleCtx);
  const directory = ctx.location.directory;

  await ctx.tool.transform((editor) => {
    for (const t of startup) {
      editor.add({
        name: t.name,
        description: t.description,
        // The tool's real argument shape, so the model sees named parameters
        // (signals, trace, text, ...) instead of an opaque nested `args`
        // record. Tools without one keep the legacy envelope. Zod schemas
        // implement Standard Schema, which opencode accepts directly.
        input: t.argsSchema
          ? z.object(t.argsSchema)
          : z.object({ args: z.record(z.string(), z.unknown().optional()) }),
        execute: async (input, toolCtx) => {
          const enabled = runtime.enabledModules(toolCtx.sessionID);
          if (!enabled.length) {
            return {
              content: `openark: no modules enabled for agent "${runtime.agent(toolCtx.sessionID)}"`,
            };
          }
          const live = toolsFor(runtime, toolCtx.sessionID).find((c) => c.name === t.name);
          if (!live) {
            return {
              content: `openark: tool "${t.name}" not available for agent "${runtime.agent(toolCtx.sessionID)}"`,
            };
          }
          const args = live.argsSchema
            ? (input as Record<string, unknown>)
            : ((input as { args?: Record<string, unknown> }).args ?? {});
          const result = await live.execute(args, { directory } satisfies ToolExecuteContext);
          return {
            content: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          };
        },
      });
    }
  });
}

const plugin: Plugin.Plugin = {
  id: "openark",
  async setup(ctx) {
    const log = createPluginLogger();
    const config = readGlobalConfig();
    const service = new ServiceClient(serviceBaseUrl(config));
    const defaultAgent = resolveAgentName();
    const directory = ctx.location.directory;

    const spawnOptions: {
      port: number;
      logger: (message: string) => void;
      serviceDir?: string;
    } = {
      port: config.servicePort,
      logger: (message) => log("info", message),
    };
    if (process.env.OPENARK_SERVICE_DIR) spawnOptions.serviceDir = process.env.OPENARK_SERVICE_DIR;
    const up = await ensureService(service, spawnOptions);
    if (!up) {
      log(
        "warn",
        "openark service unreachable — running as a no-op (start it with `openark start`)",
      );
    }

    const runtime = await createRuntime({
      defaultAgent,
      service,
      loadModules,
      collectInjections,
      log,
      directory,
    });

    await registerTools(ctx, runtime, service, log);
    const hooks = await registerHooks(ctx, runtime, log);
    log("info", `openark plugin ready (agent: ${runtime.agent()}) in ${directory}`);

    // opencode runs this when the plugin unloads (V1's `dispose` hook).
    return async () => {
      await hooks.stop();
    };
  },
};

export default plugin;
