import type {
  InjectionBlock,
  ModuleContext,
  ModuleTool,
  OpenArkModule,
  ToolResultEvent,
} from "../core/types.js";

type RecallResponse = { memories: { id: string; text: string; score: number }[] };

export const memoryModule: OpenArkModule = {
  name: "memory",
  description: "Persistent recall of facts and past sessions (Mem0-backed)",

  async init(ctx) {
    if (!(await ctx.service.health())) {
      throw new Error("openark service unreachable");
    }
  },

  async onUserMessage(ctx, message) {
    if (!message.text.trim()) return;
    await ctx.service
      .postJSON(`/v1/agents/${ctx.agent}/memory/ingest`, {
        text: message.text,
      })
      .catch(() => undefined);
  },

  async onToolResult(_ctx, _result: ToolResultEvent) {},

  async injections(ctx: ModuleContext): Promise<InjectionBlock[]> {
    try {
      const res = await ctx.service.getJSON<RecallResponse>(
        `/v1/agents/${ctx.agent}/memory/recall?limit=20`,
      );
      if (!res.memories.length) return [];
      const lines = res.memories.map((m) => `- ${m.text}`).join("\n");
      return [
        {
          title: "Remembered about you",
          body: lines,
          priority: 60,
        },
      ];
    } catch {
      return [];
    }
  },

  tools(ctx: ModuleContext): ModuleTool[] {
    return [
      {
        name: "memory_search",
        description: "Search this agent's long-term memory",
        execute: async (args) => {
          const q = typeof args.q === "string" ? args.q : "";
          return ctx.service.getJSON(
            `/v1/agents/${ctx.agent}/memory/recall?q=${encodeURIComponent(q)}&limit=10`,
          );
        },
      },
      {
        name: "memory_add",
        description: "Store a durable fact in this agent's long-term memory",
        execute: async (args) => {
          const text = typeof args.text === "string" ? args.text : "";
          if (!text.trim()) throw new Error("text is required");
          return ctx.service.postJSON(`/v1/agents/${ctx.agent}/memory`, { text });
        },
      },
    ];
  },
};
