import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedAgentHome } from "../src/core/agent-template";
import { type DoctorCheck, runDoctor } from "../src/core/doctor";
import { installAll } from "../src/core/installer";

let home: string;
let configDir: string;

function byId(checks: DoctorCheck[], id: string): DoctorCheck | undefined {
  return checks.find((check) => check.id === id);
}

function makeSkill(agent: string, slug: string, draft = false): void {
  const base = join(home, "agents", agent, "skills", draft ? "drafts" : "", slug);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "SKILL.md"), `---\nname: ${slug}\n---\n\nsteps\n`);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "openark-doctor-"));
  configDir = join(home, "opencode-config");
  process.env.OPENARK_HOME = home;
  process.env.OPENCODE_CONFIG_DIR = configDir;
  process.env.OPENARK_SERVICE_URL = "http://127.0.0.1:1";
});

afterEach(() => {
  delete process.env.OPENARK_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  delete process.env.OPENARK_SERVICE_URL;
  rmSync(home, { recursive: true, force: true });
});

describe("runDoctor on a healthy install", () => {
  it("reports ok for everything wired by installAll", async () => {
    seedAgentHome(join(home, "agents", "defoko"), "defoko");
    makeSkill("defoko", "release-checklist");
    installAll(configDir, home);

    const checks = await runDoctor({ home, configDir });

    expect(byId(checks, "plugin-shim")?.status).toBe("ok");
    expect(byId(checks, "agent-file:defoko")?.status).toBe("ok");
    expect(byId(checks, "agent-manifest:defoko")?.status).toBe("ok");
    expect(byId(checks, "skill-links")?.status).toBe("ok");
    expect(byId(checks, "commands")?.status).toBe("ok");
    expect(byId(checks, "global-config")?.status).toBe("ok");
    expect(byId(checks, "service")?.status).toBe("warn"); // nothing listening
    expect(byId(checks, "venv")?.status).toBe("error"); // not bootstrapped here
  });
});

describe("runDoctor on a broken install", () => {
  it("reports missing wiring as fixable errors and fixes restore it", async () => {
    seedAgentHome(join(home, "agents", "defoko"), "defoko");
    makeSkill("defoko", "release-checklist");

    const checks = await runDoctor({ home, configDir });
    expect(byId(checks, "plugin-shim")?.status).toBe("error");
    expect(byId(checks, "agent-file:defoko")?.status).toBe("error");
    expect(byId(checks, "skill-links")?.status).toBe("error");
    expect(byId(checks, "commands")?.status).toBe("error");

    for (const check of checks) {
      if (check.id !== "venv") check.fix?.();
    }

    const after = await runDoctor({ home, configDir });
    expect(byId(after, "plugin-shim")?.status).toBe("ok");
    expect(byId(after, "agent-file:defoko")?.status).toBe("ok");
    expect(byId(after, "skill-links")?.status).toBe("ok");
    expect(byId(after, "commands")?.status).toBe("ok");
    expect(readFileSync(join(configDir, "agents", "defoko.md"), "utf8")).toContain(
      "Managed by openark",
    );
  });

  it("refuses to fix files openark does not own", async () => {
    seedAgentHome(join(home, "agents", "defoko"), "defoko");
    mkdirSync(join(configDir, "plugins"), { recursive: true });
    writeFileSync(join(configDir, "plugins", "openark.js"), "// user-owned");
    mkdirSync(join(configDir, "agents"), { recursive: true });
    writeFileSync(join(configDir, "agents", "defoko.md"), "---\ndescription: mine\n---\n");

    const checks = await runDoctor({ home, configDir });

    const shim = byId(checks, "plugin-shim");
    expect(shim?.status).toBe("error");
    expect(shim?.fix).toBeUndefined();
    const agentFile = byId(checks, "agent-file:defoko");
    expect(agentFile?.status).toBe("error");
    expect(agentFile?.fix).toBeUndefined();
  });
});

describe("skill link checks", () => {
  it("flags missing and stale links, and the fix repairs both", async () => {
    seedAgentHome(join(home, "agents", "defoko"), "defoko");
    makeSkill("defoko", "fresh-skill");
    const skillsDir = join(configDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync(
      join(home, "agents", "defoko", "skills", "gone-skill"),
      join(skillsDir, "gone-skill"),
      "dir",
    );

    const checks = await runDoctor({ home, configDir });
    const skillCheck = byId(checks, "skill-links");
    expect(skillCheck?.status).toBe("error");
    expect(skillCheck?.message).toContain("missing links: fresh-skill");
    expect(skillCheck?.message).toContain("stale links: gone-skill");

    skillCheck?.fix?.();
    const after = await runDoctor({ home, configDir });
    expect(byId(after, "skill-links")?.status).toBe("ok");
    expect(existsSync(join(skillsDir, "fresh-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsDir, "gone-skill"))).toBe(false);
  });

  it("warns without a fix when a skill name is taken by a foreign entry", async () => {
    seedAgentHome(join(home, "agents", "defoko"), "defoko");
    makeSkill("defoko", "user-skill");
    const skillsDir = join(configDir, "skills");
    mkdirSync(join(skillsDir, "user-skill"), { recursive: true });
    writeFileSync(join(skillsDir, "user-skill", "SKILL.md"), "user skill");

    const checks = await runDoctor({ home, configDir });
    const skillCheck = byId(checks, "skill-links");
    expect(skillCheck?.status).toBe("warn");
    expect(skillCheck?.message).toContain("user-skill");
    expect(skillCheck?.fix).toBeUndefined();
    expect(existsSync(join(skillsDir, "user-skill", "SKILL.md"))).toBe(true);
  });
});

describe("venv check", () => {
  it("reports a missing venv as a fixable error", async () => {
    const checks = await runDoctor({ home, configDir });
    const venv = byId(checks, "venv");
    expect(venv?.status).toBe("error");
    expect(typeof venv?.fix).toBe("function");
  });
});

describe("global config check", () => {
  it("rejects invalid JSON without offering a fix", async () => {
    writeFileSync(join(home, "openark.json"), "{ nope");
    const checks = await runDoctor({ home, configDir });
    const config = byId(checks, "global-config");
    expect(config?.status).toBe("error");
    expect(config?.fix).toBeUndefined();
  });

  it("rejects a non-integer servicePort", async () => {
    writeFileSync(join(home, "openark.json"), JSON.stringify({ servicePort: "x" }));
    const checks = await runDoctor({ home, configDir });
    expect(byId(checks, "global-config")?.status).toBe("error");
  });

  it("accepts a valid config", async () => {
    writeFileSync(join(home, "openark.json"), JSON.stringify({ servicePort: 9000 }));
    const checks = await runDoctor({ home, configDir });
    expect(byId(checks, "global-config")?.status).toBe("ok");
  });
});

describe("agent home checks", () => {
  it("rejects a broken agent manifest without offering a fix", async () => {
    seedAgentHome(join(home, "agents", "defoko"), "defoko");
    writeFileSync(join(home, "agents", "defoko", "agent.json"), "{ nope");
    const checks = await runDoctor({ home, configDir });
    const manifest = byId(checks, "agent-manifest:defoko");
    expect(manifest?.status).toBe("error");
    expect(manifest?.fix).toBeUndefined();
  });

  it("warns about directories that are not agent homes", async () => {
    seedAgentHome(join(home, "agents", "defoko"), "defoko");
    mkdirSync(join(home, "agents", "leftover"));
    const checks = await runDoctor({ home, configDir });
    const orphan = byId(checks, "agent-dir:leftover");
    expect(orphan?.status).toBe("warn");
    expect(orphan?.fix).toBeUndefined();
  });
});
