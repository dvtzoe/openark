import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seedAgentHome } from "../src/core/agent-template";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "openark-seed-"));
}

describe("seedAgentHome", () => {
  it("creates the full agent skeleton", () => {
    const dir = join(tempHome(), "agent");
    seedAgentHome(dir, "defoko", "the mascot");
    for (const path of [
      "agent.json",
      "persona.core.md",
      "persona.evolving.md",
      "lessons.md",
      "skills",
      "data",
      "logs",
    ]) {
      expect(existsSync(join(dir, path)), path).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(join(dir, "agent.json"), "utf8"));
    expect(manifest.name).toBe("defoko");
    expect(manifest.modules).toEqual({
      memory: true,
      personality: true,
      reflection: true,
      skills: true,
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to overwrite an existing home", () => {
    const dir = join(tempHome(), "agent");
    seedAgentHome(dir, "a");
    expect(() => seedAgentHome(dir, "a")).toThrow(/already exists/);
    rmSync(dir, { recursive: true, force: true });
  });
});
