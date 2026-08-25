#!/usr/bin/env node
// Scaffold a new openark module: make create-module name=my-module
import { mkdirSync, writeFileSync, existsSync, appendFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const name = process.argv[2]

if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error("usage: make create-module name=my-module (lowercase, hyphens)")
  process.exit(1)
}

const modPath = join(root, "plugin/src/modules", `${name}.ts`)
const testPath = join(root, "plugin/tests", `${name}.test.ts`)
const registryPath = join(root, "plugin/src/modules/index.ts")

if (existsSync(modPath)) {
  console.error(`module already exists: ${modPath}`)
  process.exit(1)
}

const camel = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())

writeFileSync(
  modPath,
  `import type { OpenArkModule, ModuleContext } from "../core/types.js"

export const ${camel}Module: OpenArkModule = {
  name: "${name}",
  description: "TODO: one sentence",

  async init(_ctx: ModuleContext): Promise<void> {
    // TODO: validate service dependencies; throw to disable the module.
  },

  async onUserMessage(_ctx, _message) {},
  async onToolResult(_ctx, _result) {},
  async onSessionEnd(_ctx) {},

  async injections(_ctx) {
    return []
  },

  tools() {
    return []
  },
}
`,
)

writeFileSync(
  testPath,
  `import { describe, expect, it } from "vitest"
import { ${camel}Module } from "../src/modules/${name}"

describe("${name} module", () => {
  it("has metadata", () => {
    expect(${camel}Module.name).toBe("${name}")
    expect(${camel}Module.description).toBeTruthy()
  })

  it("returns injectable blocks", async () => {
    const blocks = await ${camel}Module.injections({} as never)
    expect(Array.isArray(blocks)).toBe(true)
  })
})
`,
)

appendFileSync(
  registryPath,
  `export { ${camel}Module } from "./${name}"\n`,
)

console.log(`created ${modPath}`)
console.log(`created ${testPath}`)
console.log(`registered in ${registryPath}`)
console.log("next: implement init/injections/tools, add agent.json toggle, add tests")
