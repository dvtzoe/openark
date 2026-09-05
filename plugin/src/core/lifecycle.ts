import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { installedVenvPython } from "./bootstrap.js";
import { DEFAULT_SERVICE_PORT, openarkHome } from "./config.js";
import type { ServiceClient } from "./service.js";

const HEALTH_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 500;

export type SpawnOptions = {
  serviceDir?: string;
  pythonBin?: string;
  home?: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
  logger?: (message: string) => void;
};

export type ResolvePythonOptions = Pick<SpawnOptions, "serviceDir" | "pythonBin" | "home" | "env">;

export function serviceDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENARK_SERVICE_DIR ?? join(process.cwd(), "service");
}

export function devVenvPython(dir: string): string {
  return join(dir, ".venv", "bin", "python");
}

// Pick the python that will run the service. An explicit pythonBin always
// wins. Otherwise the installed venv (~/.openark/venv, bootstrapped by
// `openark install`) is preferred because it works from any cwd — the dev
// venv only exists inside a service checkout, so resolving it from
// `process.cwd()/service` breaks auto-spawn in every other project. When a
// service dir is explicitly given (option or OPENARK_SERVICE_DIR) the dev
// venv under it wins instead, since that signals dev intent.
export function resolveServicePython(options: ResolvePythonOptions = {}): string | null {
  if (options.pythonBin) {
    return existsSync(options.pythonBin) ? options.pythonBin : null;
  }
  const env = options.env ?? process.env;
  const explicitDir = options.serviceDir ?? env.OPENARK_SERVICE_DIR;
  const installed = installedVenvPython(options.home ?? openarkHome());
  const installedOk = existsSync(installed);
  const dir = explicitDir ?? serviceDirFromEnv(env);
  const dev = devVenvPython(dir);
  const devOk = existsSync(dev);
  if (explicitDir) return devOk ? dev : installedOk ? installed : null;
  return installedOk ? installed : devOk ? dev : null;
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
  const python = resolveServicePython(options);
  if (!python) return null;
  const port = options.port ?? DEFAULT_SERVICE_PORT;
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
