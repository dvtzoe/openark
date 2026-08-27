import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GlobalConfig } from "./types.js";

// Mirrored by core/config.py's own `service_port: int = 8765` default on
// the Python side — that copy is unavoidable (no shared constant is
// possible across the TS/Python boundary) and must be kept in sync by
// hand if this ever changes.
export const DEFAULT_SERVICE_PORT = 8765;

export function openarkHome(): string {
  return process.env.OPENARK_HOME ?? join(homedir(), ".openark");
}

export function agentHome(agent: string, home: string = openarkHome()): string {
  return join(home, "agents", agent);
}

export function readGlobalConfig(home: string = openarkHome()): GlobalConfig {
  const defaults: GlobalConfig = { servicePort: DEFAULT_SERVICE_PORT, models: {} };
  const path = join(home, "openark.json");
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
  return process.env.OPENARK_AGENT ?? "defoko";
}
