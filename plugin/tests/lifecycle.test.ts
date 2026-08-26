import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ensureService,
  serviceDirFromEnv,
  spawnService,
  venvPython,
  waitForHealth,
} from "../src/core/lifecycle";
import type { ServiceClient } from "../src/core/service";

describe("serviceDirFromEnv", () => {
  it("prefers OPENARK_SERVICE_DIR", () => {
    expect(serviceDirFromEnv({ OPENARK_SERVICE_DIR: "/x/y" } as NodeJS.ProcessEnv)).toBe("/x/y");
  });

  it("falls back to ./service", () => {
    expect(serviceDirFromEnv({} as NodeJS.ProcessEnv)).toBe(join(process.cwd(), "service"));
  });
});

describe("waitForHealth", () => {
  it("returns true when the service is healthy", async () => {
    const client = { health: vi.fn(async () => true) } as unknown as ServiceClient;
    expect(await waitForHealth(client, 100, 10)).toBe(true);
  });

  it("returns false after timing out", async () => {
    const client = { health: vi.fn(async () => false) } as unknown as ServiceClient;
    expect(await waitForHealth(client, 60, 20)).toBe(false);
  });

  it("recovers when health flips mid-wait", async () => {
    let calls = 0;
    const client = {
      health: vi.fn(async () => {
        calls += 1;
        return calls >= 2;
      }),
    } as unknown as ServiceClient;
    expect(await waitForHealth(client, 500, 10)).toBe(true);
  });
});

describe("spawnService", () => {
  it("returns null when the venv python is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "openark-lifecycle-"));
    try {
      expect(spawnService({ serviceDir: dir })).toBeNull();
      expect(venvPython(dir)).toBe(join(dir, ".venv", "bin", "python"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("spawns uvicorn when the venv exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openark-lifecycle-"));
    try {
      mkdirSync(join(dir, ".venv", "bin"), { recursive: true });
      const python = join(dir, ".venv", "bin", "python");
      writeFileSync(python, "#!/bin/sh\nexit 0\n");
      const child = spawnService({ serviceDir: dir, port: 8799 });
      expect(child).not.toBeNull();
      await new Promise((resolve) => {
        (child ?? { on: () => {}, once: () => {} }).once?.("exit", resolve);
        setTimeout(resolve, 2000);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ensureService", () => {
  it("skips spawning when already healthy", async () => {
    const client = { health: vi.fn(async () => true) } as unknown as ServiceClient;
    const spawnSpy = vi.fn();
    const result = await ensureService(client, {});
    expect(result).toBe(true);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("gives up when spawning is impossible and health never comes up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openark-lifecycle-"));
    try {
      const client = { health: vi.fn(async () => false) } as unknown as ServiceClient;
      const result = await ensureService(client, { serviceDir: dir });
      expect(result).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
