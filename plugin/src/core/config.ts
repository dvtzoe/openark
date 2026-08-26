import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GlobalConfig } from "./types.js";

export function openarkHome(): string {
  return process.env.OPENARK_HOME ?? join(homedir(), ".openark");
}

export function agentHome(agent: string, home: string = openarkHome()): string {
  return join(home, "agents", agent);
}

export function readGlobalConfig(): GlobalConfig {
  const defaults: GlobalConfig = { servicePort: 8765, models: {} };
  const path = join(openarkHome(), "openark.json");
  if (!existsSync(path)) return defaults;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<GlobalConfig>;
    return {
      servicePort: parsed.servicePort ?? defaults.servicePort,
      models: parsed.models ?? {},
    };
  } catch {
    return defaults;
  }
}

export function serviceBaseUrl(config: GlobalConfig): string {
  const fromEnv = process.env.OPENARK_SERVICE_URL;
  if (fromEnv) return fromEnv;
  return `http://127.0.0.1:${config.servicePort}`;
}

export function resolveAgentName(): string {
  return process.env.OPENARK_AGENT ?? "chiai";
}
