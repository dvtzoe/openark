import type { Plugin } from "@opencode/plugin";
import type { Runtime } from "./runtime.js";

export type HooksLogger = (level: "info" | "warn" | "error", message: string) => void;

export type PluginContext = Plugin.Context;

// V2 events carry their payload under `data` (V1 used `properties`). Keep a
// narrow structural type instead of importing the whole protocol union: only
// the session lifecycle events below matter, and tests fabricate them.
export type SessionEvent = {
  readonly type: string;
  readonly data?: unknown;
};

export type Hooks = {
  stop(): Promise<void>;
};

function sessionIDOf(event: SessionEvent): string | undefined {
  const data = event.data as { sessionID?: unknown } | undefined;
  return typeof data?.sessionID === "string" ? data.sessionID : undefined;
}

// `session.idle` flushes the session's modules (reflection buffers, memory
// extraction); `session.deleted` drops per-session state without a flush.
export async function handleSessionEvent(runtime: Runtime, event: SessionEvent): Promise<void> {
  const sessionID = sessionIDOf(event);
  if (!sessionID) return;
  if (event.type === "session.idle") {
    await runtime.onSessionEnd(sessionID);
  } else if (event.type === "session.deleted") {
    runtime.forgetSession(sessionID);
  }
}

async function registerSessionHooks(
  ctx: PluginContext,
  runtime: Runtime,
  log: HooksLogger,
): Promise<void> {
  // V1's `chat.message` hook. V2 splits prompt admission from model calls:
  // this runs once per admitted user prompt, before any model sees it, so
  // the session's agent/modules must be noted here — the model-call hooks
  // below resolve the session's modules and would otherwise fall back to the
  // default agent for the first turn.
  await ctx.session.hook("prompt", async (event) => {
    try {
      const info = await ctx.session.get({ sessionID: event.sessionID });
      const model = info.model ? `${info.model.providerID}/${info.model.id}` : undefined;
      await runtime.noteSession(
        event.sessionID,
        info.agent ?? runtime.agent(event.sessionID),
        model,
      );
      const text = event.prompt.text.trim();
      if (text) await runtime.onUserMessage(event.sessionID, text);
    } catch (err) {
      log("warn", `prompt handling failed: ${String(err)}`);
    }
  });

  // V1's `experimental.chat.system.transform`. `context` runs immediately
  // before each model request (agent loop, compaction, ...), so the agent
  // and model are available without an extra session lookup.
  await ctx.session.hook("context", async (event) => {
    try {
      await runtime.noteSession(
        event.sessionID,
        event.agent,
        `${event.model.providerID}/${event.model.id}`,
      );
      const text = await runtime.injections(event.sessionID);
      if (text) event.system.push({ type: "text", text: `# openark\n${text}` });
    } catch (err) {
      log("warn", `injection failed: ${String(err)}`);
    }
  });
}

// V2 has no `message.part.updated` event, so tool outcomes come from the tool
// lifecycle hooks. Only failures reach the runtime, matching V1's behavior;
// `execute.before` timestamps let `execute.after` report a duration.
async function registerToolHooks(
  ctx: PluginContext,
  runtime: Runtime,
  log: HooksLogger,
): Promise<void> {
  const started = new Map<string, number>();

  await ctx.tool.hook("execute.before", (event) => {
    started.set(event.id, Date.now());
  });

  await ctx.tool.hook("execute.after", async (event) => {
    const startedAt = started.get(event.id);
    started.delete(event.id);
    if (event.status !== "error") return;
    try {
      await runtime.onToolResult(event.sessionID, {
        tool: event.tool,
        ok: false,
        durationMs: startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt),
        summary: event.error.message,
      });
    } catch (err) {
      log("warn", `tool result handling failed: ${String(err)}`);
    }
  });
}

export async function registerHooks(
  ctx: PluginContext,
  runtime: Runtime,
  log: HooksLogger,
): Promise<Hooks> {
  await registerSessionHooks(ctx, runtime, log);
  await registerToolHooks(ctx, runtime, log);

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          await handleSessionEvent(runtime, event);
        } catch (err) {
          log("warn", `event handling failed: ${String(err)}`);
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) log("warn", `event subscription failed: ${String(err)}`);
    }
  })();

  // Cleanup runs when opencode unloads the plugin (V1's `dispose` hook).
  return {
    async stop() {
      controller.abort();
      await runtime.onSessionEnd();
    },
  };
}
