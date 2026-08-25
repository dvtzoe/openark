import type { Plugin } from "@opencode-ai/plugin";
import { readGlobalConfig, resolveAgentName, serviceBaseUrl } from "./core/config.js";
import { collectInjections, loadModules } from "./core/loader.js";
import { ServiceClient } from "./core/service.js";
import type { AgentManifest, ModuleContext, OpenArkModule } from "./core/types.js";

const log = (level: "info" | "warn" | "error", message: string) => {
  console[level](`[openark:${level}] ${message}`);
};

export const plugin: Plugin = async () => {
  const config = readGlobalConfig();
  const agent = resolveAgentName();
  const service = new ServiceClient(serviceBaseUrl(config));

  let active: OpenArkModule[] = [];
  let ctx: ModuleContext | null = null;

  if (await service.health()) {
    try {
      const manifest = await service.getJSON<AgentManifest>(`/v1/agents/${agent}`);
      ctx = { agent, manifest, service, log };
      active = await loadModules(ctx);
      const names = active.map((m) => m.name).join(", ") || "none";
      log("info", `agent "${agent}" loaded modules: ${names}`);
    } catch (err) {
      log("warn", `agent "${agent}" unavailable: ${String(err)}`);
    }
  } else {
    log("warn", "openark service unreachable — running as no-op (start it with `openark start`)");
  }

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      if (!ctx || active.length === 0) return;
      try {
        const text = await collectInjections(active, ctx);
        if (!text) return;
        output.system.push(`# openark\n${text}`);
      } catch (err) {
        log("warn", `injection failed: ${String(err)}`);
      }
    },

    "tool.execute.after": async (input, output) => {
      if (!ctx) return;
      try {
        const summary = typeof output?.output === "string" ? output.output.slice(0, 200) : "";
        for (const mod of active) {
          await mod.onToolResult?.(ctx, { tool: input.tool, ok: true, durationMs: 0, summary });
        }
      } catch {
        return;
      }
    },

    event: async (input) => {
      if (!ctx) return;
      const type = (input as { type?: string })?.type;
      try {
        if (type === "session.end" || type === "session.idle") {
          for (const mod of active) await mod.onSessionEnd?.(ctx);
        }
        if (type === "message.updated") {
          const message = (input as { message?: { role?: string; parts?: { text?: string }[] } })
            ?.message;
          const text = (message?.parts ?? [])
            .map((p) => (typeof p?.text === "string" ? p.text : ""))
            .join(" ");
          if (message?.role === "user" && text.trim()) {
            for (const mod of active) await mod.onUserMessage?.(ctx, { role: "user", text });
          }
        }
      } catch {
        return;
      }
    },
  };
};

export default plugin;
