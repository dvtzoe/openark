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
import type { ModuleContext, ModuleTool, ToolExecuteContext } from "./core/types.js";

const log = (level: "info" | "warn" | "error", message: string) => {
  console[level](`[openark:${level}] ${message}`);
};

function collectTools(runtime: Runtime): Record<string, ReturnType<typeof tool>> {
  const ctx = runtime.ctx();
  if (!ctx) return {};
  const record: Record<string, ReturnType<typeof tool>> = {};
  for (const mod of runtime.active()) {
    for (const t of mod.tools?.(ctx as ModuleContext) ?? []) {
      if (t.name in record) continue;
      record[t.name] = tool({
        description: t.description,
        args: { args: z.record(z.string(), z.unknown().optional()) },
        execute: async (input, context) => {
          const enabled = runtime.enabledModules();
          if (!enabled.length) {
            return `openark: no modules enabled for agent "${runtime.agent()}"`;
          }
          const result = await t.execute((input.args ?? {}) as Record<string, unknown>, {
            directory: context.directory,
          } satisfies ToolExecuteContext);
          return typeof result === "string" ? result : JSON.stringify(result, null, 2);
        },
      });
    }
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
