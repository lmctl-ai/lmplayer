import { describe, expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import yargs, { type Argv } from "yargs"
import {
  WebCommand,
  buildWebServerInfo,
  formatWebServerInfoText,
  writeWebServerOutputFile,
} from "../../src/cli/cmd/web"
import {
  ServeCommand,
  buildServerInfo,
  formatServerInfoText,
  writeServerOutputFile,
} from "../../src/cli/cmd/serve"

describe("WebCommand and ServeCommand builders and options", () => {
  test("WebCommand registers open, no-open, output, and json options", () => {
    const builder = WebCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.open).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.port).toBeDefined()
    expect(options.key.hostname).toBeDefined()
  })

  test("ServeCommand registers output, json, and network options", () => {
    const builder = ServeCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.port).toBeDefined()
    expect(options.key.hostname).toBeDefined()
  })
})

describe("buildWebServerInfo and formatWebServerInfoText", () => {
  test("builds web server info for specific hostname and formats text", () => {
    const info = buildWebServerInfo({
      hostname: "127.0.0.1",
      port: 4096,
      url: "http://127.0.0.1:4096",
      openedBrowser: true,
    })

    expect(info.url).toBe("http://127.0.0.1:4096")
    expect(info.hostname).toBe("127.0.0.1")
    expect(info.port).toBe(4096)
    expect(info.localUrl).toBeUndefined()
    expect(info.networkUrls).toEqual([])
    expect(info.openedBrowser).toBe(true)

    const lines = formatWebServerInfoText(info)
    expect(lines[0]).toBe("lmplayer web interface started")
    expect(lines).toContain("  Web interface:  http://127.0.0.1:4096")
    expect(lines).toContain("  Browser:        opened")
  })

  test("builds web server info for 0.0.0.0 with network IPs and mDNS", () => {
    const info = buildWebServerInfo({
      hostname: "0.0.0.0",
      port: 4096,
      networkIPs: ["192.168.1.50", "10.0.0.5"],
      mdns: true,
      mdnsDomain: "my-pc.local",
      openedBrowser: false,
    })

    expect(info.url).toBe("http://localhost:4096")
    expect(info.localUrl).toBe("http://localhost:4096")
    expect(info.networkUrls).toEqual(["http://192.168.1.50:4096", "http://10.0.0.5:4096"])
    expect(info.mdns).toBe(true)
    expect(info.mdnsUrl).toBe("http://my-pc.local:4096")
    expect(info.openedBrowser).toBe(false)

    const lines = formatWebServerInfoText(info)
    expect(lines).toContain("  Local access:   http://localhost:4096")
    expect(lines).toContain("  Network access: http://192.168.1.50:4096")
    expect(lines).toContain("  Network access: http://10.0.0.5:4096")
    expect(lines).toContain("  mDNS:           http://my-pc.local:4096")
    expect(lines).toContain("  Browser:        skipped")
  })
})

describe("buildServerInfo and formatServerInfoText", () => {
  test("builds server info and formats listening URL line", () => {
    const info = buildServerInfo({
      hostname: "127.0.0.1",
      port: 4096,
      url: "http://127.0.0.1:4096",
    })

    expect(info.url).toBe("http://127.0.0.1:4096")
    expect(info.hostname).toBe("127.0.0.1")
    expect(info.port).toBe(4096)

    const lines = formatServerInfoText(info)
    expect(lines[0]).toBe("lmplayer server listening on http://127.0.0.1:4096")
  })
})

describe("writeWebServerOutputFile and writeServerOutputFile", () => {
  test("writes web server details as formatted text and JSON", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "web-server-test-"))
    try {
      const textFile = path.join(tempDir, "web", "server.txt")
      const jsonFile = path.join(tempDir, "web", "server.json")

      const info = buildWebServerInfo({
        hostname: "127.0.0.1",
        port: 4096,
        url: "http://127.0.0.1:4096",
        openedBrowser: false,
      })

      await writeWebServerOutputFile(textFile, info, false)
      const textContent = await fs.readFile(textFile, "utf-8")
      expect(textContent).toContain("lmplayer web interface started")
      expect(textContent).toContain("http://127.0.0.1:4096")

      await writeWebServerOutputFile(jsonFile, info, true)
      const jsonContent = await fs.readFile(jsonFile, "utf-8")
      const parsed = JSON.parse(jsonContent)
      expect(parsed.port).toBe(4096)
      expect(parsed.url).toBe("http://127.0.0.1:4096")
      expect(parsed.openedBrowser).toBe(false)
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  test("writes headless server details as formatted text and JSON", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "serve-server-test-"))
    try {
      const textFile = path.join(tempDir, "serve", "info.txt")
      const jsonFile = path.join(tempDir, "serve", "info.json")

      const info = buildServerInfo({
        hostname: "0.0.0.0",
        port: 8080,
      })

      await writeServerOutputFile(textFile, info, false)
      const textContent = await fs.readFile(textFile, "utf-8")
      expect(textContent).toContain("lmplayer server listening on http://0.0.0.0:8080")

      await writeServerOutputFile(jsonFile, info, true)
      const jsonContent = await fs.readFile(jsonFile, "utf-8")
      const parsed = JSON.parse(jsonContent)
      expect(parsed.hostname).toBe("0.0.0.0")
      expect(parsed.port).toBe(8080)
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })
})
