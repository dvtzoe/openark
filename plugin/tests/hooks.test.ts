import type { Part } from "@opencode-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { buildHooks, toolFailure, userText } from "../src/core/hooks";
import type { Runtime } from "../src/core/runtime";

function fakeRuntime(): Runtime & {
  notedSessions: Array<[string, string]>;
  forgottenSessions: string[];
  userMessages: string[];
  toolResults: unknown[];
  ends: string[];
  injectionsText: string;
} {
  return {
    notedSessions: [],
    forgottenSessions: [],
    userMessages: [],
    toolResults: [],
    ends: [],
    injectionsText: "## Persona\nwarm",
    agent: () => "defoko",
    manifest: () => null,
    active: () => [],
    ctx: () => null,
    enabledModules: () => ["memory"],
    noteSession: vi.fn(async function (this: never, sessionID: string, agent: string) {
      (this as unknown as { notedSessions: Array<[string, string]> }).notedSessions.push([
        sessionID,
        agent,
      ]);
    }),
    forgetSession: vi.fn(function (this: never, sessionID: string) {
      (this as unknown as { forgottenSessions: string[] }).forgottenSessions.push(sessionID);
    }),
    onUserMessage: vi.fn(async function (this: never, _sessionID: string, text: string) {
      (this as unknown as { userMessages: string[] }).userMessages.push(text);
    }),
    onToolResult: vi.fn(async function (this: never, _sessionID: string, result: unknown) {
      (this as unknown as { toolResults: unknown[] }).toolResults.push(result);
    }),
    onSessionEnd: vi.fn(async function (this: never, sessionID?: string) {
      (this as unknown as { ends: string[] }).ends.push(sessionID ?? "(all)");
    }),
    injections: vi.fn(async function (this: never) {
      return (this as unknown as { injectionsText: string }).injectionsText;
    }),
  } as unknown as ReturnType<typeof fakeRuntime>;
}

function textPart(text: string): Part {
  return { type: "text", text } as Part;
}

function toolPart(state: Record<string, unknown>, sessionID = "s1"): Part {
  return { type: "tool", tool: "bash", sessionID, state } as unknown as Part;
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
    const failure = toolFailure(toolPart({ status: "error", error: "exit 1" }, "s1"));
    expect(failure).toEqual({
      tool: "bash",
      ok: false,
      durationMs: 0,
      summary: "exit 1",
      sessionID: "s1",
    });
  });

  it("computes duration for completed tools", () => {
    const failure = toolFailure(
      toolPart({ status: "completed", output: "done", time: { start: 1000, end: 1500 } }, "s1"),
    );
    expect(failure).toEqual({
      tool: "bash",
      ok: true,
      durationMs: 500,
      summary: "done",
      sessionID: "s1",
    });
  });

  it("ignores running and pending tools", () => {
    expect(toolFailure(toolPart({ status: "running" }))).toBeNull();
    expect(toolFailure(toolPart({ status: "pending" }))).toBeNull();
  });

  it("ignores non-tool parts", () => {
    expect(toolFailure(textPart("hi"))).toBeNull();
  });
});

describe("buildHooks", () => {
  it("routes user messages through chat.message, noting the session's agent first", async () => {
    const runtime = fakeRuntime();
    const hooks = buildHooks(runtime);
    await hooks["chat.message"]?.(
      { sessionID: "s1", agent: "defoko" },
      {
        message: { role: "user", agent: "defoko" },
        parts: [textPart("hello")],
      },
    );
    expect(runtime.notedSessions).toEqual([["s1", "defoko"]]);
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
        properties: { part: toolPart({ status: "error", error: "exit 2" }, "s1") },
      },
    });
    expect(runtime.toolResults).toEqual([
      { tool: "bash", ok: false, durationMs: 0, summary: "exit 2", sessionID: "s1" },
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

  it("flushes only the idle session on session.idle", async () => {
    const runtime = fakeRuntime();
    const hooks = buildHooks(runtime);
    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    expect(runtime.ends).toEqual(["s1"]);
  });

  it("forgets a session on session.deleted", async () => {
    const runtime = fakeRuntime();
    const hooks = buildHooks(runtime);
    await hooks.event?.({
      event: { type: "session.deleted", properties: { info: { id: "s1" } } },
    });
    expect(runtime.forgottenSessions).toEqual(["s1"]);
  });

  it("flushes every session on dispose", async () => {
    const runtime = fakeRuntime();
    const hooks = buildHooks(runtime);
    await hooks.dispose?.();
    expect(runtime.ends).toEqual(["(all)"]);
  });

  it("registers tools when provided", () => {
    const runtime = fakeRuntime();
    const hooks = buildHooks(runtime, { memory_search: {} });
    expect(Object.keys(hooks.tool ?? {})).toEqual(["memory_search"]);
  });
});
