#!/usr/bin/env bun
import { spawn } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { seedAgentHome } from "./core/agent-template.js";
import { bootstrapVenv } from "./core/bootstrap.js";
import { agentHome, openarkHome, readGlobalConfig, serviceBaseUrl } from "./core/config.js";
import { type DoctorCheck, runDoctor } from "./core/doctor.js";
import {
  installAll,
  isManagedFile,
  listAgents,
  opencodeConfigDir,
  packageRoot,
  readAgentDescription,
  uninstallAll,
} from "./core/installer.js";
import {
  clearServicePid,
  isProcessAlive,
  openServiceLog,
  readServicePid,
  resolveServicePython,
  serviceDirFromEnv,
  stopService,
  waitForHealth,
  writeServicePid,
} from "./core/lifecycle.js";
import { ServiceClient } from "./core/service.js";

const USAGE = `openark — modular agents for opencode

Usage: openark <command> [args]

Commands:
  list                          list agents (~/.openark/agents)
  create <name> [--persona p]   create a new agent home (optionally seeded
                                from a bundled persona, e.g. defoko)
  rm <name> --yes               delete an agent home (irreversible)
  start [--foreground|-f]       start the openark service (daemon by default;
                                --foreground runs attached for logs)
  stop                          stop the openark service
  restart [--foreground|-f]     stop + start the service (needed after
                                openark.json, prompts/, or service code
                                changes — see below)
  status                        check whether the service is up
  doctor [--fix]                check the setup for problems; --fix repairs
                                what it can (shim, agent files, skills,
                                commands, service venv)
  install                       wire openark into opencode (plugin shim, agent
                                files, skills, commands, service venv)
  uninstall                     remove openark wiring from opencode (plugin
                                shim, agent files, skills, commands)
  version                       print version

Restart policy:
  No restart needed (next session picks it up): agent.json toggles,
  persona.core.md (.d/), persona.evolving.md (.d/), lessons.md, skills/.
  Restart needed: ~/.openark/openark.json (port/model routing),
  service prompts/ and service code, plugin code (also re-run install
  and restart opencode itself for plugin changes).

Environment:
  OPENARK_HOME            state root (default ~/.openark)
  OPENARK_SERVICE_DIR     service source checkout (dev installs)
  OPENCODE_CONFIG_DIR     opencode config dir (default ~/.config/opencode)
`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function listAgentsCmd(): void {
  const names = listAgents();
  if (!names.length) {
    console.log("no agents yet — create one with: openark create <name>");
    return;
  }
  for (const name of names) {
    console.log(`${name} — ${readAgentDescription(name)}`);
  }
}

function bundledPersonas(): string[] {
  const dir = join(packageRoot(), "personas");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => existsSync(join(dir, name, "persona.core.md")));
}

function seedFromPersona(dir: string, name: string, persona: string): void {
  const source = join(packageRoot(), "personas", persona);
  const manifest = JSON.parse(readFileSync(join(source, "agent.json"), "utf8"));
  seedAgentHome(dir, name, manifest.description);
  for (const file of ["persona.core.md", "persona.evolving.md"]) {
    const content = readFileSync(join(source, file), "utf8").replace(/^#\s+.*$/m, `# ${name}`);
    rmSync(join(dir, file));
    writeFileSync(join(dir, file), content);
    // Bundled personas may ship drop-in directories (persona.<base>.md.d/);
    // copy them so seeded agents read the same fragment set.
    const dropin = join(source, `${file}.d`);
    if (existsSync(dropin)) cpSync(dropin, join(dir, `${file}.d`), { recursive: true });
  }
}

function createAgent(name: string, persona?: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    fail("agent names are lowercase, may contain digits and hyphens");
  }
  if (persona) {
    const available = bundledPersonas();
    if (!available.includes(persona)) {
      fail(`unknown persona '${persona}' — bundled: ${available.join(", ") || "(none)"}`);
    }
  }
  try {
    const dir = agentHome(name);
    if (persona) {
      seedFromPersona(dir, name, persona);
    } else {
      seedAgentHome(dir, name);
    }
    console.log(`created agent home: ${dir}`);
    if (persona) console.log(`seeded persona: ${persona}`);
    console.log("next: edit persona.core.md, then run: openark install");
  } catch (err) {
    fail(String(err));
  }
}

function removeAgent(name: string, yes: boolean): void {
  // Same validation as createAgent: without it `openark rm ../../Documents`
  // would path-join out of the agents directory and delete arbitrary trees.
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    fail("agent names are lowercase, may contain digits and hyphens");
  }
  const dir = agentHome(name);
  if (!existsSync(dir)) fail(`no such agent: ${name}`);
  if (!yes) fail(`refusing to delete ${dir} without --yes`);
  rmSync(dir, { recursive: true, force: true });
  // Also drop the generated opencode agent file, otherwise opencode keeps
  // listing the deleted agent until an install prunes it.
  const agentFile = join(opencodeConfigDir(), "agents", `${name}.md`);
  if (isManagedFile(agentFile)) rmSync(agentFile, { force: true });
  console.log(`deleted ${dir}`);
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8"));
  return typeof pkg.version === "string" ? pkg.version : "0.0.0-dev";
}

function servicePython(): string {
  const python = resolveServicePython();
  if (python) return python;
  return fail("service venv missing — run: openark install (or `make dev` in a dev checkout)");
}

async function startService(foreground: boolean): Promise<void> {
  const python = servicePython();
  const config = readGlobalConfig();
  const home = openarkHome();
  if (foreground) {
    const child = spawn(
      python,
      [
        "-m",
        "uvicorn",
        "openark.app:app",
        "--host",
        "127.0.0.1",
        "--port",
        String(config.servicePort),
      ],
      { stdio: "inherit" },
    );
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }
  stopStalePidFile(home);
  const client = new ServiceClient(serviceBaseUrl(config));
  if (await client.health()) {
    const pid = readServicePid(home);
    console.log(pid !== null ? `service: already up (pid ${pid})` : "service: already up");
    return;
  }
  // Daemon output goes to ~/.openark/logs/service.log so a failed start
  // (bad venv, import error, port conflict) leaves a readable traceback.
  const logFd = openServiceLog(home);
  const child = spawn(
    python,
    [
      "-m",
      "uvicorn",
      "openark.app:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(config.servicePort),
    ],
    {
      stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
      detached: true,
    },
  );
  if (logFd !== null) closeSync(logFd);
  child.on("error", (err) => fail(`failed to start service: ${String(err)}`));
  child.unref();
  if (child.pid !== undefined) {
    try {
      writeServicePid(home, child.pid);
    } catch {
      // best-effort; stop can still find the service by port
    }
  }
  if (await waitForHealth(client)) {
    console.log(
      child.pid !== undefined
        ? `service: up on 127.0.0.1:${config.servicePort} (pid ${child.pid})`
        : `service: up on 127.0.0.1:${config.servicePort}`,
    );
  } else {
    fail("service did not become healthy in time — check ~/.openark/logs/service.log");
  }
}

function stopStalePidFile(home: string): void {
  const pid = readServicePid(home);
  if (pid !== null && !isProcessAlive(pid)) {
    clearServicePid(home);
  }
}

async function stopServiceCmd(): Promise<void> {
  const config = readGlobalConfig();
  const client = new ServiceClient(serviceBaseUrl(config));
  const result = await stopService(client, { home: openarkHome(), port: config.servicePort });
  if (result.stopped) {
    console.log(`service: stopped (pid ${result.pid})`);
  } else if (result.reason === "not-running") {
    console.log("service: not running");
  } else if (result.reason === "timeout") {
    fail(`service pid ${result.pid} did not stop in time (SIGKILL sent)`);
  } else if (result.reason === "not-service") {
    fail(
      `process ${result.pid} does not look like the openark service — refusing to kill it (stale pid file cleared)`,
    );
  } else {
    fail("service seems up but no pid file found — kill the uvicorn process by hand");
  }
}

async function restartServiceCmd(foreground: boolean): Promise<void> {
  const config = readGlobalConfig();
  const client = new ServiceClient(serviceBaseUrl(config));
  const result = await stopService(client, { home: openarkHome(), port: config.servicePort });
  if (result.stopped) {
    console.log(`service: stopped (pid ${result.pid})`);
  } else if (result.reason === "not-running") {
    console.log("service: was not running");
  } else if (result.reason === "timeout") {
    fail(`service pid ${result.pid} did not stop in time — aborting restart`);
  } else if (result.reason === "not-service") {
    fail(`process ${result.pid} does not look like the openark service — aborting restart`);
  } else {
    fail("service seems up but no pid file found — kill the uvicorn process by hand first");
  }
  await startService(foreground);
}

async function checkService(): Promise<void> {
  const config = readGlobalConfig();
  const client = new ServiceClient(serviceBaseUrl(config));
  if (!(await client.health())) {
    console.log("service: down");
    return;
  }
  const pid = readServicePid(openarkHome());
  console.log(pid !== null ? `service: up (pid ${pid})` : "service: up");
}

function printChecks(checks: DoctorCheck[]): void {
  for (const check of checks) {
    const label = check.status.padEnd(5);
    const hint = check.hint ? ` (${check.hint})` : "";
    const fixable = check.status !== "ok" && check.fix ? " — fixable with --fix" : "";
    console.log(`${label} ${check.message}${hint}${fixable}`);
  }
}

async function doctorCmd(fix: boolean): Promise<void> {
  const serviceDir = serviceDirFromEnv();
  let checks = await runDoctor({ serviceDir });
  if (fix) {
    for (const check of checks) {
      if (check.status === "ok" || !check.fix) continue;
      try {
        console.log(`fixed: ${check.fix()}`);
      } catch (err) {
        console.error(`could not fix ${check.id}: ${String(err)}`);
      }
    }
    checks = await runDoctor({ serviceDir });
  }
  printChecks(checks);
  const errors = checks.filter((check) => check.status === "error");
  const warns = checks.filter((check) => check.status === "warn");
  if (errors.length || warns.length) {
    console.log(`${errors.length} problem(s), ${warns.length} warning(s)`);
  }
  if (errors.length) process.exit(1);
}

function installCmd(): void {
  try {
    const { python, created } = bootstrapVenv({
      serviceDir: serviceDirFromEnv(),
    });
    console.log(created ? `bootstrapped service venv: ${python}` : `service venv ready: ${python}`);
  } catch (err) {
    console.warn(`warn: venv bootstrap skipped (${String(err)})`);
  }

  try {
    const result = installAll();
    console.log(`plugin shim: ${result.pluginPath}`);
    console.log(`agent files: ${result.agentFiles.length}`);
    for (const file of result.agentFiles) console.log(`  ${file}`);
    console.log(`skill links: ${result.skillLinks.length}`);
    for (const link of result.skillLinks) console.log(`  ${link}`);
    console.log(`commands: ${result.commandFiles.length}`);
    console.log("done — restart opencode to load the plugin");
  } catch (err) {
    fail(String(err));
  }
}

function uninstallCmd(): void {
  try {
    const result = uninstallAll();
    console.log(
      result.pluginPath
        ? `plugin shim removed: ${result.pluginPath}`
        : "plugin shim: not installed",
    );
    console.log(`agent files removed: ${result.agentFiles.length}`);
    for (const file of result.agentFiles) console.log(`  ${file}`);
    console.log(`skill links removed: ${result.skillLinks.length}`);
    for (const link of result.skillLinks) console.log(`  ${link}`);
    console.log(`commands removed: ${result.commandFiles.length}`);
    for (const file of result.commandFiles) console.log(`  ${file}`);
    console.log("done — restart opencode to unload the plugin");
    console.log(`agent data kept under ${openarkHome()}`);
  } catch (err) {
    fail(String(err));
  }
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "list":
    listAgentsCmd();
    break;
  case "create": {
    const personaIndex = args.indexOf("--persona");
    const persona = personaIndex >= 0 ? args[personaIndex + 1] : undefined;
    if (personaIndex >= 0 && !persona) {
      fail("usage: openark create <name> [--persona defoko]");
    }
    const name = args.find((arg, index) => !arg.startsWith("--") && index !== personaIndex + 1);
    if (!name) fail("usage: openark create <name> [--persona defoko]");
    createAgent(name, persona);
    break;
  }
  case "rm":
    args[0] ? removeAgent(args[0], args.includes("--yes")) : fail("usage: openark rm <name> --yes");
    break;
  case "start":
    await startService(args.includes("--foreground") || args.includes("-f"));
    break;
  case "stop":
    await stopServiceCmd();
    break;
  case "restart":
    await restartServiceCmd(args.includes("--foreground") || args.includes("-f"));
    break;
  case "status":
    await checkService();
    break;
  case "doctor":
    await doctorCmd(args.includes("--fix"));
    break;
  case "install":
    installCmd();
    break;
  case "uninstall":
    uninstallCmd();
    break;
  case "version":
    console.log(packageVersion());
    break;
  default:
    console.log(USAGE);
    process.exit(command ? 1 : 0);
}
