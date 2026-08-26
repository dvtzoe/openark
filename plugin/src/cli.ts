#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seedAgentHome } from "./core/agent-template.js";
import { bootstrapVenv, venvPython } from "./core/bootstrap.js";
import { agentHome, openarkHome, readGlobalConfig, serviceBaseUrl } from "./core/config.js";
import { installAll, listAgents, packageRoot } from "./core/installer.js";
import { ServiceClient } from "./core/service.js";

const USAGE = `openark — modular agents for opencode

Usage: openark <command> [args]

Commands:
  list                          list agents (~/.openark/agents)
  create <name> [--persona p]   create a new agent home (optionally seeded
                                from a bundled persona, e.g. chiai)
  rm <name> --yes               delete an agent home (irreversible)
  start                         start the openark service (uvicorn)
  status                        check whether the service is up
  install                       wire openark into opencode (plugin shim, agent
                                files, skills, commands, service venv)
  version                       print version

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
    const manifestPath = join(agentHome(name), "agent.json");
    let description = "";
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { description?: string };
        description = manifest.description ?? "";
      } catch {}
    }
    console.log(`${name}${description ? ` — ${description}` : ""}`);
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
    const content = readFileSync(join(source, file), "utf8").replace(/^# chiai/m, `# ${name}`);
    rmSync(join(dir, file));
    writeFileSync(join(dir, file), content);
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
  const dir = agentHome(name);
  if (!existsSync(dir)) fail(`no such agent: ${name}`);
  if (!yes) fail(`refusing to delete ${dir} without --yes`);
  rmSync(dir, { recursive: true, force: true });
  console.log(`deleted ${dir}`);
}

function servicePython(): string {
  const homeVenv = venvPython();
  if (existsSync(homeVenv)) return homeVenv;
  const serviceDir = process.env.OPENARK_SERVICE_DIR ?? join(process.cwd(), "service");
  const devVenv = join(serviceDir, ".venv", "bin", "python");
  if (existsSync(devVenv)) return devVenv;
  return fail("service venv missing — run: openark install (or `make dev` in a dev checkout)");
}

function startService(): void {
  const python = servicePython();
  const config = readGlobalConfig();
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
}

async function checkService(): Promise<void> {
  const config = readGlobalConfig();
  const client = new ServiceClient(serviceBaseUrl(config));
  console.log((await client.health()) ? "service: up" : "service: down");
}

function installCmd(): void {
  try {
    const { python, created } = bootstrapVenv({
      serviceDir: process.env.OPENARK_SERVICE_DIR ?? join(process.cwd(), "service"),
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

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "list":
    listAgentsCmd();
    break;
  case "create": {
    const name = args.find((a) => !a.startsWith("--"));
    const personaIndex = args.indexOf("--persona");
    const persona = personaIndex >= 0 ? args[personaIndex + 1] : undefined;
    if (!name) fail("usage: openark create <name> [--persona chiai]");
    createAgent(name, persona);
    break;
  }
  case "rm":
    args[0] ? removeAgent(args[0], args.includes("--yes")) : fail("usage: openark rm <name> --yes");
    break;
  case "start":
    startService();
    break;
  case "status":
    await checkService();
    break;
  case "install":
    installCmd();
    break;
  case "version":
    console.log("0.1.0");
    break;
  default:
    console.log(USAGE);
    process.exit(command ? 1 : 0);
}
