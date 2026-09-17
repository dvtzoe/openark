import type { ZodRawShape } from "zod";

export type ModuleContext = {
  agent: string;
  manifest: AgentManifest;
  service: ServiceLike;
  log: (level: "info" | "warn" | "error", message: string) => void;
  // The opencode project directory this plugin instance serves. Optional
  // because tests build bare contexts; real sessions always set it.
  directory?: string | undefined;
  // `model` is explicitly `| undefined` because tsconfig's
  // exactOptionalPropertyTypes allows assigning undefined only when the
  // type says so, and runtime.withSession() assigns it explicitly.
  session?: { id: string; model?: string | undefined } | undefined;
};

export type ServiceLike = {
  health(): Promise<boolean>;
  getJSON<T>(path: string): Promise<T>;
  postJSON<T>(path: string, body: unknown): Promise<T>;
  // Optional scoped copy that sends the session's selected model with every
  // request (background tasks fall back to it when no route is configured).
  withModel?(model: string): ServiceLike;
};

export type InjectionBlock = {
  title: string;
  body: string;
  priority: number;
};

export type ToolExecuteContext = {
  directory: string;
};

export type ModuleTool = {
  name: string;
  description: string;
  // The real argument shape registered with opencode, so the model sees
  // named parameters instead of an opaque nested record. Tools without one
  // keep the legacy `{ args: {...} }` envelope.
  argsSchema?: ZodRawShape;
  execute(args: Record<string, unknown>, context?: ToolExecuteContext): Promise<unknown>;
};

export type UserMessageEvent = {
  role: "user";
  text: string;
};

export type ToolResultEvent = {
  tool: string;
  ok: boolean;
  durationMs: number;
  summary: string;
};

export type OpenArkModule = {
  name: string;
  description: string;
  init?(ctx: ModuleContext): Promise<void>;
  onUserMessage?(ctx: ModuleContext, message: UserMessageEvent): Promise<void>;
  onToolResult?(ctx: ModuleContext, result: ToolResultEvent): Promise<void>;
  onSessionEnd?(ctx: ModuleContext): Promise<void>;
  // Sync cleanup for buffers keyed by session (session.deleted can arrive
  // without a preceding idle flush).
  onSessionDeleted?(ctx: ModuleContext): void;
  injections?(ctx: ModuleContext): Promise<InjectionBlock[]>;
  tools?(ctx: ModuleContext): ModuleTool[];
};

export type AgentManifest = {
  name: string;
  description: string;
  modules: Record<string, boolean>;
  channels: {
    subscriptions: string[];
  };
};

export type ModelRoute =
  | { inherit: "main" | "small" }
  | {
      provider: string;
      model: string;
      baseUrl?: string;
      apiKeyEnv?: string;
    };

export type TaskName =
  | "extraction"
  | "reflection"
  | "distillation"
  | "persona_update"
  | "embeddings";

export type GlobalConfig = {
  servicePort: number;
  models: Partial<Record<TaskName, ModelRoute>>;
};
