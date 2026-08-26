import type { Hooks } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import type { Runtime } from "./runtime.js";

export type HooksLogger = (level: "info" | "warn" | "error", message: string) => void;

export function userText(parts: Part[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === "text") chunks.push(part.text);
  }
  return chunks.join("\n").trim();
}

export type ToolFailure = {
  tool: string;
  ok: boolean;
  durationMs: number;
  summary: string;
};

export function toolFailure(part: Part): ToolFailure | null {
  if (part.type !== "tool") return null;
  const state = part.state;
  if (state.status === "error") {
    return { tool: part.tool, ok: false, durationMs: 0, summary: state.error };
  }
  if (state.status === "completed") {
    const durationMs =
      state.time?.start && state.time?.end ? Math.max(0, state.time.end - state.time.start) : 0;
    return { tool: part.tool, ok: true, durationMs, summary: state.output.slice(0, 200) };
  }
  return null;
}

export type SessionTracker = {
  note(sessionID: string, agent: string): Promise<void>;
  touch(sessionID: string | undefined): Promise<void>;
  forget(sessionID: string): void;
};

export function createSessionTracker(runtime: Runtime): SessionTracker {
  const sessionAgents = new Map<string, string>();
  return {
    async note(sessionID, agent) {
      sessionAgents.set(sessionID, agent);
      await runtime.switchAgent(agent);
    },
    async touch(sessionID) {
      if (!sessionID) return;
      const agent = sessionAgents.get(sessionID);
      if (agent) await runtime.switchAgent(agent);
    },
    forget(sessionID) {
      sessionAgents.delete(sessionID);
    },
  };
}

export function buildHooks(
  runtime: Runtime,
  tools: Record<string, unknown> = {},
  log: HooksLogger = () => {},
): Hooks {
  const tracker = createSessionTracker(runtime);
  const hooks: Hooks = {
    dispose: async () => {
      await runtime.onSessionEnd();
    },

    "chat.message": async (input, output) => {
      if (output.message.role !== "user") return;
      await tracker.note(input.sessionID, input.agent ?? output.message.agent);
      const text = userText(output.parts);
      if (text) await runtime.onUserMessage(text);
    },

    "experimental.chat.system.transform": async (input, output) => {
      await tracker.touch(input.sessionID);
      try {
        const text = await runtime.injections(input.sessionID);
        if (text) output.system.push(`# openark\n${text}`);
      } catch (err) {
        log("warn", `injection failed: ${String(err)}`);
      }
    },

    "tool.execute.after": async (input) => {
      await tracker.touch(input.sessionID);
    },

    event: async (input) => {
      const event = input.event;
      try {
        if (event.type === "message.part.updated") {
          const failure = toolFailure(event.properties.part);
          if (failure && !failure.ok) {
            await runtime.onToolResult(failure);
          }
        }
        if (event.type === "session.idle") {
          await tracker.touch(event.properties.sessionID);
          await runtime.onSessionEnd();
        }
        if (event.type === "session.deleted") {
          tracker.forget(event.properties.info.id);
        }
      } catch (err) {
        log("warn", `event handling failed: ${String(err)}`);
      }
    },
  };
  if (Object.keys(tools).length > 0) {
    (hooks as { tool?: Hooks["tool"] }).tool = tools as Hooks["tool"];
  }
  return hooks;
}
