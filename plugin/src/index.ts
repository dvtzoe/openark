import { tool } from "@opencode-ai/plugin";
import type { Plugin } from "@opencode-ai/plugin";
import { z } from "zod";
import { readGlobalConfig, resolveAgentName, serviceBaseUrl } from "./core/config.js";
import { buildHooks } from "./core/hooks.js";
import { ensureService } from "./core/lifecycle.js";
import { collectInjections, loadModules } from "./core/loader.js";
import { createRuntime } from "./core/runtime.js";
import type { Runtime } from "./core/runtime.js";
import { ServiceClient } from "./core/service.js";
import type { ModuleTool, ToolExecuteContext } from "./core/types.js";

const log = (level: "info" | "warn" | "error", message: string) => {
  console[level](`[openark:${level}] ${message}`);
};

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

function collectTools(runtime: Runtime): Record<string, ReturnType<typeof tool>> {
  const startup = toolsFor(runtime, undefined);
  const record: Record<string, ReturnType<typeof tool>> = {};
  for (const t of startup) {
    record[t.name] = tool({
      description: t.description,
      args: { args: z.record(z.string(), z.unknown().optional()) },
      execute: async (input, context) => {
        const enabled = runtime.enabledModules(context.sessionID);
        if (!enabled.length) {
          return `openark: no modules enabled for agent "${runtime.agent(context.sessionID)}"`;
        }
        const live = toolsFor(runtime, context.sessionID).find((c) => c.name === t.name);
        if (!live) {
          return `openark: tool "${t.name}" not available for agent "${runtime.agent(context.sessionID)}"`;
        }
        const result = await live.execute((input.args ?? {}) as Record<string, unknown>, {
          directory: context.directory,
        } satisfies ToolExecuteContext);
        return typeof result === "string" ? result : JSON.stringify(result, null, 2);
      },
    });
  }
  return record;
}

export const plugin: Plugin = async (input) => {
  const config = readGlobalConfig();
  const service = new ServiceClient(serviceBaseUrl(config));
  const defaultAgent = resolveAgentName();

  const spawnOptions: { port: number; logger: (message: string) => void; serviceDir?: string } = {
    port: config.servicePort,
    logger: (message) => log("info", message),
  };
  if (process.env.OPENARK_SERVICE_DIR) spawnOptions.serviceDir = process.env.OPENARK_SERVICE_DIR;
  const up = await ensureService(service, spawnOptions);
  if (!up) {
    log("warn", "openark service unreachable — running as no-op (start it with `openark start`)");
  }

  const runtime = await createRuntime({
    defaultAgent,
    service,
    loadModules,
    collectInjections,
    log,
  });

  const tools = collectTools(runtime);
  log("info", `openark plugin ready (agent: ${runtime.agent()}) in ${input.directory}`);
  return buildHooks(runtime, tools, log);
};

export default plugin;
