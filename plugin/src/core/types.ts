export type ModuleContext = {
  agent: string;
  manifest: AgentManifest;
  service: ServiceLike;
  log: (level: "info" | "warn" | "error", message: string) => void;
  session?: { id: string } | undefined;
};

export type ServiceLike = {
  health(): Promise<boolean>;
  getJSON<T>(path: string): Promise<T>;
  postJSON<T>(path: string, body: unknown): Promise<T>;
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
