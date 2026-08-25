import type {
  InjectionBlock,
  ModuleContext,
  OpenArkModule,
  ToolResultEvent,
} from "../core/types.js";

type LessonsResponse = { lessons: { id: string; rule: string; hits: number }[] };

const failureQueue: ToolResultEvent[] = [];

export const reflectionModule: OpenArkModule = {
  name: "reflection",
  description: "Lessons learned from failures and user corrections (Reflexion-style)",

  async init(ctx) {
    if (!(await ctx.service.health())) {
      throw new Error("openark service unreachable");
    }
  },

  async onToolResult(_ctx, result) {
    if (!result.ok) failureQueue.push(result);
  },

  async onSessionEnd(ctx) {
    if (!failureQueue.length) return;
    const failures = failureQueue.splice(0, failureQueue.length);
    await ctx.service
      .postJSON(`/v1/agents/${ctx.agent}/lessons/reflect`, { failures })
      .catch(() => undefined);
  },

  async injections(ctx: ModuleContext): Promise<InjectionBlock[]> {
    try {
      const res = await ctx.service.getJSON<LessonsResponse>(
        `/v1/agents/${ctx.agent}/lessons?active=true`,
      );
      if (!res.lessons.length) return [];
      const lines = res.lessons.map((l) => `- ${l.rule}`).join("\n");
      return [{ title: "Lessons learned", body: lines, priority: 90 }];
    } catch {
      return [];
    }
  },

  tools(_ctx: ModuleContext) {
    return [];
  },
};
