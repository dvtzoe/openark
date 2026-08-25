import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readGlobalConfig, resolveAgentName, serviceBaseUrl } from "../src/core/config";

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "openark-test-"));
  process.env.OPENARK_HOME = home;
  try {
    return fn(home);
  } finally {
    delete process.env.OPENARK_HOME;
    rmSync(home, { recursive: true, force: true });
  }
}

describe("readGlobalConfig", () => {
  it("returns defaults when no config exists", () => {
    withHome(() => {
      expect(readGlobalConfig()).toEqual({ servicePort: 8765, models: {} });
    });
  });

  it("reads openark.json", () => {
    withHome((home) => {
      writeFileSync(
        join(home, "openark.json"),
        JSON.stringify({ servicePort: 9999, models: { extraction: { inherit: "small" } } }),
      );
      const config = readGlobalConfig();
      expect(config.servicePort).toBe(9999);
      expect(config.models.extraction).toEqual({ inherit: "small" });
    });
  });

  it("falls back to defaults on malformed json", () => {
    withHome((home) => {
      writeFileSync(join(home, "openark.json"), "{not json");
      expect(readGlobalConfig().servicePort).toBe(8765);
    });
  });
});

describe("resolveAgentName", () => {
  it("defaults to chiai", () => {
    delete process.env.OPENARK_AGENT;
    expect(resolveAgentName()).toBe("chiai");
  });

  it("honors OPENARK_AGENT", () => {
    process.env.OPENARK_AGENT = "observer";
    expect(resolveAgentName()).toBe("observer");
    delete process.env.OPENARK_AGENT;
  });
});

describe("serviceBaseUrl", () => {
  it("derives from the port", () => {
    expect(serviceBaseUrl({ servicePort: 8765, models: {} })).toBe("http://127.0.0.1:8765");
  });

  it("prefers OPENARK_SERVICE_URL", () => {
    process.env.OPENARK_SERVICE_URL = "http://localhost:1";
    expect(serviceBaseUrl({ servicePort: 8765, models: {} })).toBe("http://localhost:1");
    delete process.env.OPENARK_SERVICE_URL;
  });
});
