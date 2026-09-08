import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installedVenvPython } from "./bootstrap.js";
import { DEFAULT_SERVICE_PORT, openarkHome } from "./config.js";
import type { ServiceClient } from "./service.js";

const HEALTH_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 500;
const STOP_TIMEOUT_MS = 10000;

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
  // Track the pid so `openark stop` can find auto-spawned services too.
  // Best-effort: a missing home dir or read-only FS must never break spawn.
  if (child.pid !== undefined) {
    try {
      writeServicePid(options.home ?? openarkHome(), child.pid);
    } catch {
      // ignore — stop falls back to port discovery
    }
  }
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

// --- Service process management (openark stop/restart) ----------------------
// The service runs detached (see spawnService), so its pid is tracked in
// ~/.openark/service.pid. `openark start` (daemon mode) writes it,
// `openark stop` kills it, `openark restart` is stop + start.

export function pidFilePath(home: string = openarkHome()): string {
  return join(home, "service.pid");
}

export function readServicePid(home: string = openarkHome()): number | null {
  try {
    const raw = readFileSync(pidFilePath(home), "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function writeServicePid(home: string, pid: number): void {
  writeFileSync(pidFilePath(home), `${pid}\n`);
}

export function clearServicePid(home: string = openarkHome()): void {
  try {
    rmSync(pidFilePath(home), { force: true });
  } catch {
    // best-effort
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForDown(
  client: ServiceClient,
  timeoutMs = STOP_TIMEOUT_MS,
  pollMs = POLL_INTERVAL_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await client.health())) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

function pidOnPort(port: number): number | null {
  // Best-effort discovery for services started before the pid file existed
  // (e.g. older auto-spawns). lsof may not be installed — then return null
  // and let the caller report "kill it by hand".
  try {
    const res = spawnSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" });
    if (res.status !== 0 || !res.stdout) return null;
    const first = res.stdout.trim().split(/\s+/)[0] ?? "";
    const pid = Number.parseInt(first, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export type StopResult =
  | { stopped: true; pid: number }
  | { stopped: false; reason: "not-running" | "no-pid" | "timeout"; pid?: number };

export async function stopService(
  client: ServiceClient,
  options: { home?: string; port?: number } = {},
): Promise<StopResult> {
  const home = options.home ?? openarkHome();
  const port = options.port ?? DEFAULT_SERVICE_PORT;
  let pid = readServicePid(home);
  if (pid !== null && !isProcessAlive(pid)) {
    // Stale pid file from a dead process — drop it and keep looking.
    clearServicePid(home);
    pid = null;
  }
  pid ??= pidOnPort(port);
  if (pid === null) {
    return (await client.health())
      ? { stopped: false, reason: "no-pid" }
      : { stopped: false, reason: "not-running" };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    clearServicePid(home);
    return (await client.health())
      ? { stopped: false, reason: "no-pid", pid }
      : { stopped: false, reason: "not-running", pid };
  }
  const down = await waitForDown(client);
  if (!down) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    if (!(await waitForDown(client, 5000))) {
      return { stopped: false, reason: "timeout", pid };
    }
  }
  if (readServicePid(home) === pid) clearServicePid(home);
  return { stopped: true, pid };
}
