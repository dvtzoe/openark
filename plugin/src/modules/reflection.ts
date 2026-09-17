import { z } from "zod";
import { filteredStringArray, requiredString } from "../core/args.js";
import { pushBounded } from "../core/bounded-buffer.js";
import type {
  InjectionBlock,
  ModuleContext,
  ModuleTool,
  OpenArkModule,
  ToolResultEvent,
} from "../core/types.js";
import type { components } from "../generated/api-types.js";

type LessonsResponse = components["schemas"]["LessonsResponse"];
type ReflectResponse = components["schemas"]["ReflectResponse"];
type LessonRetireResponse = components["schemas"]["LessonRetireResponse"];
type Lesson = components["schemas"]["Lesson"];

const reflectShape = { failures: filteredStringArray(), messages: filteredStringArray() };
const reflectArgs = z
  .object(reflectShape)
  .refine(
    (v) => v.failures.length > 0 || v.messages.length > 0,
    "failures or messages is required",
  );
const lessonsRetireShape = { id: requiredString("id is required") };
const lessonsListShape = { all: z.boolean().optional() };

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

// Sessions that failed at least once; cleared once a following user message
// (the correction) has been captured and flushed.
const pendingFailure = new Set<string>();

function sessionKey(ctx: ModuleContext): string {
  return ctx.session?.id ?? "";
}

export function resetBuffers(): void {
  buffers.clear();
  pendingFailure.clear();
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
    if (!text) return;
    const key = sessionKey(ctx);
    const buf = bufferFor(ctx);
    // Capture only if something failed this session (before or after the
    // idle flush) — plain chatter still doesn't trigger reflection.
    if (!pendingFailure.has(key) && buf.failures.length === 0) return;
    pushBounded(buf.messages, text, MAX_BUFFERED);
  },

  async onToolResult(ctx, result) {
    if (result.ok) return;
    pendingFailure.add(sessionKey(ctx));
    pushBounded(bufferFor(ctx).failures, result, MAX_BUFFERED);
  },

  async onSessionEnd(ctx) {
    const key = sessionKey(ctx);
    const buf = buffers.get(key);
    if (!buf || (!buf.failures.length && !buf.messages.length)) return;
    const failures = buf.failures.splice(0, buf.failures.length);
    const messages = buf.messages.splice(0, buf.messages.length);
    buffers.delete(key);
    // If the correction came along with this flush we're done; if only the
    // failure was flushed, the next user message is still the correction.
    if (messages.length) pendingFailure.delete(key);
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

  onSessionDeleted(ctx) {
    const key = sessionKey(ctx);
    buffers.delete(key);
    pendingFailure.delete(key);
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
        argsSchema: reflectShape,
        execute: async (args) => {
          const { failures, messages } = reflectArgs.parse(args);
          return ctx.service.postJSON<ReflectResponse>(`/v1/agents/${ctx.agent}/lessons/reflect`, {
            failures: failures.map((f) => ({
              tool: "manual",
              ok: false,
              duration_ms: 0,
              summary: f,
            })),
            messages,
          });
        },
      },
      {
        name: "lessons_list",
        description: "List this agent's learned lessons (active by default)",
        argsSchema: lessonsListShape,
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
        argsSchema: lessonsRetireShape,
        execute: async (args) => {
          const { id } = z.object(lessonsRetireShape).parse(args);
          return ctx.service.postJSON<LessonRetireResponse>(
            `/v1/agents/${ctx.agent}/lessons/${id}/retire`,
            {},
          );
        },
      },
    ];
  },
};
