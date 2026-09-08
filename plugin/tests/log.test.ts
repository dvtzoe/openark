import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPluginLogger } from "../src/core/log";

describe("createPluginLogger", () => {
  it("writes to ~/.openark/logs/plugin.log and never to stdout", async () => {
    const home = mkdtempSync(join(tmpdir(), "openark-log-"));
    try {
      const writes: string[] = [];
      const origStdout = process.stdout.write.bind(process.stdout);
      const origStderr = process.stderr.write.bind(process.stderr);
      // @ts-expect-error monkey-patch for assertion
      process.stdout.write = (chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      };
      // @ts-expect-error monkey-patch for assertion
      process.stderr.write = () => true;
      try {
        const log = createPluginLogger(home, {});
        log("info", "hello");
        log("warn", "oops");
      } finally {
        process.stdout.write = origStdout as typeof process.stdout.write;
        process.stderr.write = origStderr as typeof process.stderr.write;
      }
      expect(writes).toEqual([]);
      const content = readFileSync(join(home, "logs", "plugin.log"), "utf8");
      expect(content).toContain("[openark:info] hello");
      expect(content).toContain("[openark:warn] oops");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("mirrors to stderr only when OPENARK_DEBUG=1", () => {
    const home = mkdtempSync(join(tmpdir(), "openark-log-"));
    try {
      const errWrites: string[] = [];
      const origStderr = process.stderr.write.bind(process.stderr);
      // @ts-expect-error monkey-patch for assertion
      process.stderr.write = (chunk: unknown) => {
        errWrites.push(String(chunk));
        return true;
      };
      try {
        createPluginLogger(home, {} as NodeJS.ProcessEnv)("info", "quiet");
        expect(errWrites).toEqual([]);
        createPluginLogger(home, { OPENARK_DEBUG: "1" } as NodeJS.ProcessEnv)("info", "loud");
        expect(errWrites.length).toBe(1);
        expect(errWrites[0]).toContain("loud");
      } finally {
        process.stderr.write = origStderr as typeof process.stderr.write;
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
