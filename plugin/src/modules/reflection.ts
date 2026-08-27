import type { InjectionBlock, ModuleContext, ModuleTool, OpenArkModule } from "../core/types.js";
import type { ToolResultEvent } from "../core/types.js";
import type { components } from "../generated/api-types.js";

type LessonsResponse = components["schemas"]["LessonsResponse"];
type ReflectResponse = components["schemas"]["ReflectResponse"];
type LessonRetireResponse = components["schemas"]["LessonRetireResponse"];
type Lesson = components["schemas"]["Lesson"];

const MAX_BUFFERED = 100;

type SessionBuffer = {
  failures: ToolResultEvent[];
  messages: string[];
};

// Keyed by session, not shared across the process: two concurrent sessions
// (same or different agent) must never mix failures/corrections. See
// docs/plans/0003-findings-plugin-modules.md #1.
const buffers = new Map<string, SessionBuffer>();
let countedSessions = new Set<string>();

function bufferFor(ctx: ModuleContext): SessionBuffer {
  const key = ctx.session?.id ?? "";
  let buf = buffers.get(key);
  if (!buf) {
    buf = { failures: [], messages: [] };
    buffers.set(key, buf);
  }
  return buf;
}

function registerHits(ctx: ModuleContext, lessons: Lesson[]): void {
  const sessionID = ctx.session?.id;
  if (!sessionID || countedSessions.has(sessionID)) return;
  countedSessions.add(sessionID);
  if (countedSessions.size > 500) {
    countedSessions = new Set([...countedSessions].slice(-250));
  }
  ctx.service
    .postJSON(`/v1/agents/${ctx.agent}/lessons/hits`, {
      ids: lessons.map((l) => l.id),
      session_id: sessionID,
    })
    .catch(() => undefined);
}

export function resetBuffers(): void {
  buffers.clear();
  countedSessions = new Set();
}

export const reflectionModule: OpenArkModule = {
  name: "reflection",
  description: "Lessons learned from failures and user corrections (Reflexion-style)",

  async init(ctx) {
    if (!(await ctx.service.health())) {
      throw new Error("openark service unreachable");
    }
  },

  async onUserMessage(ctx, message) {
    const text = message.text.trim();
    const buf = bufferFor(ctx);
    if (!text || buf.failures.length === 0) return;
    if (buf.messages.length >= MAX_BUFFERED) buf.messages.shift();
    buf.messages.push(text);
  },

  async onToolResult(ctx, result) {
    if (result.ok) return;
    const buf = bufferFor(ctx);
    if (buf.failures.length >= MAX_BUFFERED) buf.failures.shift();
    buf.failures.push(result);
  },

  async onSessionEnd(ctx) {
    const key = ctx.session?.id ?? "";
    const buf = buffers.get(key);
    if (!buf || (!buf.failures.length && !buf.messages.length)) return;
    const failures = buf.failures.splice(0, buf.failures.length);
    const messages = buf.messages.splice(0, buf.messages.length);
    buffers.delete(key);
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
