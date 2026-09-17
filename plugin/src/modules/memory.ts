import { basename } from "node:path";
import { z } from "zod";
import { requiredString } from "../core/args.js";
import { pushBounded } from "../core/bounded-buffer.js";
import type {
  InjectionBlock,
  ModuleContext,
  ModuleTool,
  OpenArkModule,
  ToolExecuteContext,
} from "../core/types.js";
import type { components } from "../generated/api-types.js";

const memoryAddShape = { text: requiredString("text is required") };
const memoryAddArgs = z.object(memoryAddShape);
const channelShareShape = {
  text: requiredString("text is required"),
  channel: requiredString("channel is required"),
  kind: z.unknown().transform((v) => (v === "lesson" ? "lesson" : "memory")),
};
const channelShareArgs = z.object(channelShareShape);
const channelItemsShape = { channel: requiredString("channel is required") };
const channelItemsArgs = z.object(channelItemsShape);
const channelSubscribeShape = {
  channel: requiredString("channel is required"),
  subscribe: z.boolean().optional(),
};
const channelSubscribeArgs = z.object(channelSubscribeShape);
const memorySearchShape = { q: z.string().optional() };

type MemoryItem = components["schemas"]["MemoryItem"];
type RecallResponse = components["schemas"]["MemoryRecallResponse"];
type MutationResponse = components["schemas"]["MemoryMutation"];
type IngestResponse = components["schemas"]["MemoryIngestResponse"];
type ChannelItem = components["schemas"]["ChannelItem"];

function provenanceLine(m: MemoryItem): string {
  return m.source_agent ? `- ${m.text} (shared by ${m.source_agent})` : `- ${m.text}`;
}

const MAX_BUFFERED_MESSAGES = 200;

// Keyed by session, not a single shared array: two concurrent sessions
// (same or different agent) must never see each other's buffered
// transcript. See docs/plans/0003-findings-plugin-modules.md #1.
const transcripts = new Map<string, string[]>();

function currentProject(directory?: string): string | undefined {
  try {
    return basename(directory ?? process.cwd()) || undefined;
  } catch {
    return undefined;
  }
}

function resetTranscript(): void {
  transcripts.clear();
}

export const memoryModule: OpenArkModule = {
  name: "memory",
  description: "Persistent recall of facts and past sessions (Mem0-backed)",

  async init(ctx) {
    if (!(await ctx.service.health())) {
      throw new Error("openark service unreachable");
    }
  },

  async onUserMessage(ctx, message) {
    const text = message.text.trim();
    if (!text) return;
    const key = ctx.session?.id ?? "";
    const transcript = transcripts.get(key) ?? [];
    pushBounded(transcript, `user: ${text}`, MAX_BUFFERED_MESSAGES);
    transcripts.set(key, transcript);
  },

  async onSessionEnd(ctx) {
    const key = ctx.session?.id ?? "";
    const transcript = transcripts.get(key);
    if (!transcript?.length) return;
    const conversation = transcript.join("\n");
    transcripts.delete(key);
    const project = currentProject(ctx.directory);
    await ctx.service
      .postJSON<IngestResponse>(`/v1/agents/${ctx.agent}/memory/ingest`, {
        text: conversation,
        project,
      })
      .catch(() => undefined);
  },

  onSessionDeleted(ctx) {
    // No idle flush arrived (session deleted mid-flight) — drop the buffer
    // instead of leaking it for the life of the process.
    transcripts.delete(ctx.session?.id ?? "");
  },

  async injections(ctx: ModuleContext): Promise<InjectionBlock[]> {
    try {
      const res = await ctx.service.getJSON<RecallResponse>(
        `/v1/agents/${ctx.agent}/memory/recall?limit=20`,
      );
      const memories = (res.memories ?? []).filter((m: MemoryItem) => m.text?.trim());
      if (!memories.length) return [];
      const lines = memories.map((m: MemoryItem) => provenanceLine(m)).join("\n");
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
        argsSchema: memorySearchShape,
        execute: async (args) => {
          const q = typeof args.q === "string" ? args.q : "";
          return ctx.service.getJSON<RecallResponse>(
            `/v1/agents/${ctx.agent}/memory/recall?q=${encodeURIComponent(q)}&limit=10`,
          );
        },
      },
      {
        name: "memory_add",
        description: "Store a durable fact in this agent's long-term memory",
        argsSchema: memoryAddShape,
        execute: async (args, context?: ToolExecuteContext) => {
          const { text } = memoryAddArgs.parse(args);
          return ctx.service.postJSON<MutationResponse>(`/v1/agents/${ctx.agent}/memory`, {
            text,
            project: currentProject(context?.directory),
          });
        },
      },
      {
        name: "channel_share",
        description:
          "Share a memory or lesson with a channel other agents can subscribe to. " +
          "The user must confirm before pushing. Channel names look like 'team' or '#team'.",
        argsSchema: channelShareShape,
        execute: async (args) => {
          const { text, channel, kind } = channelShareArgs.parse(args);
          return ctx.service.postJSON<ChannelItem>(
            `/v1/agents/${ctx.agent}/channels/${encodeURIComponent(channel)}`,
            { text, kind },
          );
        },
      },
      {
        name: "channel_items",
        description: "List items shared in a channel",
        argsSchema: channelItemsShape,
        execute: async (args) => {
          const { channel } = channelItemsArgs.parse(args);
          return ctx.service.getJSON<ChannelItem[]>(`/v1/channels/${encodeURIComponent(channel)}`);
        },
      },
      {
        name: "channel_subscribe",
        description: "Subscribe (or unsubscribe with subscribe: false) to a channel",
        argsSchema: channelSubscribeShape,
        execute: async (args) => {
          const { channel } = channelSubscribeArgs.parse(args);
          const action = args.subscribe === false ? "unsubscribe" : "subscribe";
          return ctx.service.postJSON<string[]>(
            `/v1/agents/${ctx.agent}/channels/${encodeURIComponent(channel)}/${action}`,
            {},
          );
        },
      },
    ];
  },
};

export { resetTranscript };
