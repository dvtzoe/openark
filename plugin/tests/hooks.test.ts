import type { Part } from "@opencode-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { buildHooks, createSessionTracker, toolFailure, userText } from "../src/core/hooks";
import type { Runtime } from "../src/core/runtime";

function fakeRuntime(): Runtime & {
  userMessages: string[];
  toolResults: unknown[];
  ends: number;
  injectionsText: string;
} {
  return {
    userMessages: [],
    toolResults: [],
    ends: 0,
    injectionsText: "## Persona\nwarm",
    agent: () => "defoko",
    manifest: () => null,
    active: () => [],
    ctx: () => null,
    switchAgent: vi.fn(async () => {}),
    onUserMessage: vi.fn(async function (this: never, text: string) {
      (this as unknown as { userMessages: string[] }).userMessages.push(text);
    }),
    onToolResult: vi.fn(async function (this: never, result: unknown) {
      (this as unknown as { toolResults: unknown[] }).toolResults.push(result);
    }),
    onSessionEnd: vi.fn(async function (this: never) {
      (this as unknown as { ends: number }).ends += 1;
    }),
    injections: vi.fn(async function (this: never) {
      return (this as unknown as { injectionsText: string }).injectionsText;
    }),
    enabledModules: () => ["memory"],
  } as unknown as ReturnType<typeof fakeRuntime>;
}

function textPart(text: string): Part {
  return { type: "text", text } as Part;
}

function toolPart(state: Record<string, unknown>): Part {
  return { type: "tool", tool: "bash", state } as unknown as Part;
}

describe("userText", () => {
  it("joins text parts and trims", () => {
    expect(userText([textPart(" hello "), textPart("world")])).toBe("hello \nworld");
  });

  it("ignores non-text parts", () => {
    expect(userText([toolPart({ status: "pending" }) as Part, textPart("hi")])).toBe("hi");
  });
});

describe("toolFailure", () => {
  it("extracts errors from tool parts", () => {
    const failure = toolFailure(toolPart({ status: "error", error: "exit 1" }));
    expect(failure).toEqual({ tool: "bash", ok: false, durationMs: 0, summary: "exit 1" });
  });

  it("computes duration for completed tools", () => {
    const failure = toolFailure(
      toolPart({ status: "completed", output: "done", time: { start: 1000, end: 1500 } }),
    );
    expect(failure).toEqual({ tool: "bash", ok: true, durationMs: 500, summary: "done" });
  });

  it("ignores running and pending tools", () => {
    expect(toolFailure(toolPart({ status: "running" }))).toBeNull();
    expect(toolFailure(toolPart({ status: "pending" }))).toBeNull();
  });

  it("ignores non-tool parts", () => {
    expect(toolFailure(textPart("hi"))).toBeNull();
  });
});

describe("createSessionTracker", () => {
  it("maps sessions to agents and switches", async () => {
    const runtime = fakeRuntime();
    const tracker = createSessionTracker(runtime);
    await tracker.note("s1", "observer");
    expect(runtime.switchAgent).toHaveBeenCalledWith("observer");
    await tracker.touch("s1");
    expect(runtime.switchAgent).toHaveBeenCalledTimes(2);
    tracker.forget("s1");
    await tracker.touch("s1");
    expect(runtime.switchAgent).toHaveBeenCalledTimes(2);
  });

  it("touch without a mapping does nothing", async () => {
    const runtime = fakeRuntime();
    const tracker = createSessionTracker(runtime);
    await tracker.touch("unknown");
    expect(runtime.switchAgent).not.toHaveBeenCalled();
  });
});

describe("buildHooks", () => {
  it("routes user messages through chat.message", async () => {
    const runtime = fakeRuntime();
    const hooks = buildHooks(runtime);
    await hooks["chat.message"]?.(
      { sessionID: "s1", agent: "defoko" },
      {
        message: { role: "user", agent: "defoko" },
        parts: [textPart("hello")],
      },
    );
    expect(runtime.userMessages).toEqual(["hello"]);
  });

  it("ignores assistant messages", async () => {
    const runtime = fakeRuntime();
    const hooks = buildHooks(runtime);
    await hooks["chat.message"]?.(
      { sessionID: "s1" },
      { message: { role: "assistant" }, parts: [textPart("hi")] },
    );
    expect(runtime.userMessages).toEqual([]);
  });

  it("injects into the system prompt", async () => {
    const runtime = fakeRuntime();
    const hooks = buildHooks(runtime);
    const output = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]?.({ sessionID: "s1" }, output);
    expect(output.system[1]).toContain("# openark");
    expect(output.system[1]).toContain("## Persona");
  });

  it("does not inject when empty", async () => {
    const runtime = fakeRuntime();
    runtime.injectionsText = "";
    const hooks = buildHooks(runtime);
    const output = { system: [] };
    await hooks["experimental.chat.system.transform"]?.({ sessionID: "s1" }, output);
    expect(output.system).toEqual([]);
  });

  it("feeds tool errors to the runtime", async () => {
    const runtime = fakeRuntime();
    const hooks = buildHooks(runtime);
    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: { part: toolPart({ status: "error", error: "exit 2" }) },
      },
    });
    expect(runtime.toolResults).toEqual([
      { tool: "bash", ok: false, durationMs: 0, summary: "exit 2" },
    ]);
  });

  it("ignores successful tool completions", async () => {
    const runtime = fakeRuntime();
    const hooks = buildHooks(runtime);
    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: { part: toolPart({ status: "completed", output: "ok" }) },
      },
    });
    expect(runtime.toolResults).toEqual([]);
  });

  it("flushes on session.idle", async () => {
    const runtime = fakeRuntime();
    const hooks = buildHooks(runtime);
    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    expect(runtime.ends).toBe(1);
  });

  it("flushes on dispose", async () => {
    const runtime = fakeRuntime();
    const hooks = buildHooks(runtime);
    await hooks.dispose?.();
    expect(runtime.ends).toBe(1);
  });

  it("registers tools when provided", () => {
    const runtime = fakeRuntime();
    const hooks = buildHooks(runtime, { memory_search: {} });
    expect(Object.keys(hooks.tool ?? {})).toEqual(["memory_search"]);
  });
});
