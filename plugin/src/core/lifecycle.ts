import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

// Open the daemon's log file (stdout+stderr both go here) so a failed
// service start leaves a traceback someone can read. Best-effort: a
// missing/unwritable home falls back to discarding output.
export function openServiceLog(home: string = openarkHome()): number | null {
  try {
    mkdirSync(join(home, "logs"), { recursive: true });
    return openSync(join(home, "logs", "service.log"), "a");
  } catch {
    return null;
  }
}

export function spawnService(options: SpawnOptions = {}): ReturnType<typeof spawn> | null {
  const python = resolveServicePython(options);
  if (!python) return null;
  const port = options.port ?? DEFAULT_SERVICE_PORT;
  const home = options.home ?? openarkHome();
  const logFd = openServiceLog(home);
  const child = spawn(
    python,
    ["-m", "uvicorn", "openark.app:app", "--host", "127.0.0.1", "--port", String(port)],
    {
      env: options.env ?? process.env,
      stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
      detached: true,
    },
  );
  if (logFd !== null) closeSync(logFd);
  child.on("error", () => {});
  child.unref();
  // Track the pid so `openark stop` can find auto-spawned services too.
  // Best-effort: a missing home dir or read-only FS must never break spawn.
  if (child.pid !== undefined) {
    try {
      writeServicePid(home, child.pid);
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
    // Strict: "123abc" or a pid followed by junk must not become a kill
    // target after pid reuse.
    if (!/^\d+$/.test(raw)) return null;
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

// Process liveness and identity. isProcessAlive can't tell "our service"
// from "some other process that now owns a recycled pid"; before signaling
// we ask ps what the process actually is. null means "could not verify"
// (ps missing), in which case the caller keeps the old permissive behavior.
const SERVICE_CMD_MARKERS = ["uvicorn", "openark.app"];

function isServiceProcess(pid: number): boolean | null {
  try {
    const res = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    if (res.error || res.status !== 0) return null;
    const command = (res.stdout ?? "").trim();
    if (!command) return null;
    return SERVICE_CMD_MARKERS.every((marker) => command.includes(marker));
  } catch {
    return null;
  }
}

function pidOnPort(port: number): number | null {
  // Best-effort discovery for services started before the pid file existed
  // (e.g. older auto-spawns). lsof may not be installed — then return null
  // and let the caller report "kill it by hand". -sTCP:LISTEN is essential:
  // without it lsof also matches ESTABLISHED client sockets, and opencode
  // itself holds a connection to the service.
  try {
    const res = spawnSync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    if (res.status !== 0 || !res.stdout) return null;
    for (const token of res.stdout.trim().split(/\s+/)) {
      const pid = Number.parseInt(token, 10);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (isServiceProcess(pid) !== false) return pid;
    }
    return null;
  } catch {
    return null;
  }
}

export type StopResult =
  | { stopped: true; pid: number }
  | { stopped: false; reason: "not-running" | "no-pid" | "timeout" | "not-service"; pid?: number };

// Waits until the process is gone AND health is down. Health alone is not
// enough: a wedged process can fail health while still holding the port, and
// a successful stop must not be reported while the old process lingers.
export async function waitForExit(
  pid: number,
  client: ServiceClient,
  timeoutMs = STOP_TIMEOUT_MS,
  pollMs = POLL_INTERVAL_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid) && !(await client.health())) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

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
  if (isServiceProcess(pid) === false) {
    // The pid now belongs to some other process (recycled pid or a client
    // socket). Never signal it; drop the stale pid file.
    if (readServicePid(home) === pid) clearServicePid(home);
    return (await client.health())
      ? { stopped: false, reason: "not-service", pid }
      : { stopped: false, reason: "not-running", pid };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    clearServicePid(home);
    return (await client.health())
      ? { stopped: false, reason: "no-pid", pid }
      : { stopped: false, reason: "not-running", pid };
  }
  if (!(await waitForExit(pid, client, STOP_TIMEOUT_MS))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    if (!(await waitForExit(pid, client, 5000))) {
      return { stopped: false, reason: "timeout", pid };
    }
  }
  if (readServicePid(home) === pid) clearServicePid(home);
  return { stopped: true, pid };
}
