#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { seedAgentHome } from "./core/agent-template.js";
import { agentHome, openarkHome, readGlobalConfig, serviceBaseUrl } from "./core/config.js";
import { ServiceClient } from "./core/service.js";

const USAGE = `openark — modular agents for opencode

Usage: openark <command> [args]

Commands:
  list                 list agents (~/.openark/agents)
  create <name>        create a new agent home with default files
  rm <name> --yes      delete an agent home (irreversible)
  start                start the openark service (uvicorn)
  status               check whether the service is up
  install              wire openark into opencode (coming in phase 8)
  version              print version

Environment:
  OPENARK_HOME         state root (default ~/.openark)
  OPENARK_SERVICE_DIR  repo service/ directory (default ./service)
`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function listAgents(): void {
  const dir = join(openarkHome(), "agents");
  if (!existsSync(dir)) {
    console.log("no agents yet — create one with: openark create <name>");
    return;
  }
  const names = readdirSync(dir).filter((n) => existsSync(agentHome(n)));
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

function createAgent(name: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    fail("agent names are lowercase, may contain digits and hyphens");
  }
  try {
    seedAgentHome(agentHome(name), name);
    console.log(`created agent home: ${agentHome(name)}`);
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

function startService(): void {
  const serviceDir = process.env.OPENARK_SERVICE_DIR ?? join(process.cwd(), "service");
  if (!existsSync(serviceDir)) {
    fail(`service directory not found: ${serviceDir} (set OPENARK_SERVICE_DIR)`);
  }
  const config = readGlobalConfig();
  const python = join(serviceDir, ".venv", "bin", "python");
  if (!existsSync(python)) fail(`service venv missing — run: make dev (in ${serviceDir})`);
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

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "list":
    listAgents();
    break;
  case "create":
    args[0] ? createAgent(args[0]) : fail("usage: openark create <name>");
    break;
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
    console.log("openark install lands in phase 8 — see docs/plans/phases.md");
    process.exit(2);
    break;
  case "version":
    console.log("0.1.0");
    break;
  default:
    console.log(USAGE);
    process.exit(command ? 1 : 0);
}
