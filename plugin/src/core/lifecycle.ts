import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServiceClient } from "./service.js";

const HEALTH_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 500;

export type SpawnOptions = {
  serviceDir?: string;
  pythonBin?: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
  logger?: (message: string) => void;
};

export function serviceDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENARK_SERVICE_DIR ?? join(process.cwd(), "service");
}

export function venvPython(dir: string): string {
  return join(dir, ".venv", "bin", "python");
}

export async function waitForHealth(
  client: ServiceClient,
  timeoutMs = HEALTH_TIMEOUT_MS,
  pollMs = POLL_INTERVAL_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.health()) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

export function spawnService(options: SpawnOptions = {}): ReturnType<typeof spawn> | null {
  const dir = options.serviceDir ?? serviceDirFromEnv();
  const python = options.pythonBin ?? venvPython(dir);
  if (!existsSync(python)) return null;
  const port = options.port ?? 8765;
  const child = spawn(
    python,
    ["-m", "uvicorn", "openark.app:app", "--host", "127.0.0.1", "--port", String(port)],
    { env: options.env ?? process.env, stdio: "ignore", detached: true },
  );
  child.on("error", () => {});
  child.unref();
  options.logger?.(`spawned openark service on 127.0.0.1:${port}`);
  return child;
}

export async function ensureService(
  client: ServiceClient,
  options: SpawnOptions = {},
): Promise<boolean> {
  if (await client.health()) return true;
  const spawned = spawnService(options);
  if (!spawned) return false;
  return waitForHealth(client);
}
