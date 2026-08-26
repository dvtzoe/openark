import type { InjectionBlock, ModuleContext, ModuleTool, OpenArkModule } from "../core/types.js";
import type { ToolResultEvent } from "../core/types.js";
import type { components } from "../generated/api-types.js";

type LessonsResponse = components["schemas"]["LessonsResponse"];
type ReflectResponse = components["schemas"]["ReflectResponse"];
type LessonRetireResponse = components["schemas"]["LessonRetireResponse"];
type Lesson = components["schemas"]["Lesson"];

const MAX_BUFFERED = 100;

type Buffers = {
  failures: ToolResultEvent[];
  messages: string[];
  countedSessions: Set<string>;
};

const buffers: Buffers = { failures: [], messages: [], countedSessions: new Set() };

function registerHits(ctx: ModuleContext, lessons: Lesson[]): void {
  const sessionID = ctx.session?.id;
  if (!sessionID || buffers.countedSessions.has(sessionID)) return;
  buffers.countedSessions.add(sessionID);
  if (buffers.countedSessions.size > 500) {
    buffers.countedSessions = new Set([...buffers.countedSessions].slice(-250));
  }
  ctx.service
    .postJSON(`/v1/agents/${ctx.agent}/lessons/hits`, {
      ids: lessons.map((l) => l.id),
      session_id: sessionID,
    })
    .catch(() => undefined);
}

export function resetBuffers(): void {
  buffers.failures = [];
  buffers.messages = [];
  buffers.countedSessions = new Set();
}

export const reflectionModule: OpenArkModule = {
  name: "reflection",
  description: "Lessons learned from failures and user corrections (Reflexion-style)",

  async init(ctx) {
    if (!(await ctx.service.health())) {
      throw new Error("openark service unreachable");
    }
  },

  async onUserMessage(_ctx, message) {
    const text = message.text.trim();
    if (!text || buffers.failures.length === 0) return;
    if (buffers.messages.length >= MAX_BUFFERED) buffers.messages.shift();
    buffers.messages.push(text);
  },

  async onToolResult(_ctx, result) {
    if (result.ok) return;
    if (buffers.failures.length >= MAX_BUFFERED) buffers.failures.shift();
    buffers.failures.push(result);
  },

  async onSessionEnd(ctx) {
    if (!buffers.failures.length && !buffers.messages.length) return;
    const failures = buffers.failures.splice(0, buffers.failures.length);
    const messages = buffers.messages.splice(0, buffers.messages.length);
    await ctx.service
      .postJSON<ReflectResponse>(`/v1/agents/${ctx.agent}/lessons/reflect`, {
        failures: failures.map((f) => ({
          tool: f.tool,
          ok: f.ok,
          duration_ms: f.durationMs,
          summary: f.summary,
        })),
        messages,
      })
      .catch(() => undefined);
  },

  async injections(ctx: ModuleContext): Promise<InjectionBlock[]> {
    try {
      const res = await ctx.service.getJSON<LessonsResponse>(
        `/v1/agents/${ctx.agent}/lessons?active=true`,
      );
      const lessons = (res.lessons ?? []).filter((l: Lesson) => l.rule?.trim());
      if (!lessons.length) return [];
      registerHits(ctx, lessons);
      const lines = lessons.map((l: Lesson) => `- ${l.rule}`).join("\n");
      return [{ title: "Lessons learned", body: lines, priority: 90 }];
    } catch {
      return [];
    }
  },

  tools(ctx: ModuleContext): ModuleTool[] {
    return [
      {
        name: "reflect",
        description:
          "Reflect on failures and extract durable lessons. Pass each failure as a " +
          "short description in the failures array; optionally pass user correction messages.",
        execute: async (args) => {
          const failures = Array.isArray(args.failures)
            ? args.failures
                .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
                .map((f) => ({ tool: "manual", ok: false, duration_ms: 0, summary: f }))
            : [];
          const messages = Array.isArray(args.messages)
            ? args.messages.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
            : [];
          if (!failures.length && !messages.length) {
            throw new Error("failures or messages is required");
          }
          return ctx.service.postJSON<ReflectResponse>(`/v1/agents/${ctx.agent}/lessons/reflect`, {
            failures,
            messages,
          });
        },
      },
      {
        name: "lessons_list",
        description: "List this agent's learned lessons (active by default)",
        execute: async (args) => {
          const includeRetired = args.all === true;
          return ctx.service.getJSON<LessonsResponse>(
            `/v1/agents/${ctx.agent}/lessons?active=${includeRetired ? "false" : "true"}`,
          );
        },
      },
      {
        name: "lessons_retire",
        description: "Retire a learned lesson by id so it is no longer injected",
        execute: async (args) => {
          const id = typeof args.id === "string" ? args.id.trim() : "";
          if (!id) throw new Error("id is required");
          return ctx.service.postJSON<LessonRetireResponse>(
            `/v1/agents/${ctx.agent}/lessons/${id}/retire`,
            {},
          );
        },
      },
    ];
  },
};
