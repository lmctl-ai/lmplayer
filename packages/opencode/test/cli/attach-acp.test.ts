import { describe, expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import yargs, { type Argv } from "yargs"
import {
  AttachCommand,
  formatAttachCheckText,
  writeAttachCheckOutputFile,
  checkAttach,
  type AttachCheckResult,
} from "../../src/cli/cmd/attach"
import {
  AcpCommand,
  buildAcpServerInfo,
  formatAcpServerInfoText,
  writeAcpServerOutputFile,
} from "../../src/cli/cmd/acp"

describe("AttachCommand and AcpCommand builders and options", () => {
  test("AttachCommand registers check, output, and json options", () => {
    const builder = AttachCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.check).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.dir).toBeDefined()
    expect(options.key.directory).toBeDefined()
    expect(options.key.d).toBeDefined()
    expect(options.key.session).toBeDefined()
    expect(options.key.continue).toBeDefined()
    expect(options.key.fork).toBeDefined()
    expect(options.key.password).toBeDefined()
    expect(options.key.p).toBeDefined()
    expect(options.key.username).toBeDefined()
    expect(options.key.u).toBeDefined()
  })

  test("AttachCommand parses options and aliases from arguments", async () => {
    const parsed = await yargs().command({ ...AttachCommand, handler: () => {} }).parseAsync([
      "attach",
      "http://localhost:4096",
      "-d",
      "/path/to/project",
      "-s",
      "ses_123",
      "--fork",
      "-p",
      "secret",
      "-u",
      "admin",
      "-o",
      "check.json",
      "--json",
    ])
    expect(parsed.url).toBe("http://localhost:4096")
    expect(parsed.d).toBe("/path/to/project")
    expect(parsed.s).toBe("ses_123")
    expect(parsed.fork).toBe(true)
    expect(parsed.p).toBe("secret")
    expect(parsed.u).toBe("admin")
    expect(parsed.output).toBe("check.json")
    expect(parsed.json).toBe(true)
  })

  test("AcpCommand registers cwd, output, json, and network options", () => {
    const builder = AcpCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.cwd).toBeDefined()
    expect(options.key.dir).toBeDefined()
    expect(options.key.directory).toBeDefined()
    expect(options.key.d).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.port).toBeDefined()
    expect(options.key.hostname).toBeDefined()
  })

  test("AcpCommand parses options and aliases from arguments", async () => {
    const parsed = await yargs().command({ ...AcpCommand, handler: () => {} }).parseAsync([
      "acp",
      "--dir",
      "/my/working/dir",
      "--port",
      "5050",
      "--hostname",
      "0.0.0.0",
      "-o",
      "acp.json",
      "--json",
    ])
    expect(parsed.dir).toBe("/my/working/dir")
    expect(parsed.port).toBe(5050)
    expect(parsed.hostname).toBe("0.0.0.0")
    expect(parsed.output).toBe("acp.json")
    expect(parsed.json).toBe(true)
  })
})

describe("formatAttachCheckText", () => {
  test("formats healthy attach check without session", () => {
    const result: AttachCheckResult = {
      url: "http://localhost:4096",
      healthy: true,
      version: "1.2.3",
      authenticated: true,
      checkedAt: "2026-09-22T05:00:00.000Z",
    }
    const lines = formatAttachCheckText(result)
    expect(lines[0]).toBe("Server status: healthy")
    expect(lines).toContain("  URL:           http://localhost:4096")
    expect(lines).toContain("  Version:       1.2.3")
    expect(lines).toContain("  Authenticated: yes")
    expect(lines).toContain("  Checked at:    2026-09-22T05:00:00.000Z")
  })

  test("formats healthy attach check with session and fork", () => {
    const result: AttachCheckResult = {
      url: "http://127.0.0.1:4096",
      healthy: true,
      authenticated: false,
      directory: "/tmp/project",
      session: {
        id: "ses_abc123",
        title: "Test Session",
      },
      fork: true,
      checkedAt: "2026-09-22T05:00:00.000Z",
    }
    const lines = formatAttachCheckText(result)
    expect(lines[0]).toBe("Server status: healthy")
    expect(lines).toContain("  Authenticated: no")
    expect(lines).toContain("  Directory:     /tmp/project")
    expect(lines).toContain("  Session:       ses_abc123 (Test Session)")
    expect(lines).toContain("  Fork:          yes")
  })

  test("formats unhealthy attach check with error", () => {
    const result: AttachCheckResult = {
      url: "http://127.0.0.1:4096",
      healthy: false,
      authenticated: false,
      error: "Connection refused",
      checkedAt: "2026-09-22T05:00:00.000Z",
    }
    const lines = formatAttachCheckText(result)
    expect(lines[0]).toBe("Server status: unhealthy")
    expect(lines).toContain("  Error:         Connection refused")
  })
})

describe("writeAttachCheckOutputFile", () => {
  test("writes attach check result as formatted text and JSON", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "attach-test-"))
    try {
      const textFile = path.join(tempDir, "check.txt")
      const jsonFile = path.join(tempDir, "check.json")

      const result: AttachCheckResult = {
        url: "http://localhost:4096",
        healthy: true,
        version: "0.1.0",
        authenticated: false,
        checkedAt: "2026-09-22T05:00:00.000Z",
      }

      await writeAttachCheckOutputFile(textFile, result, false)
      const textContent = await fs.readFile(textFile, "utf-8")
      expect(textContent).toContain("Server status: healthy")
      expect(textContent).toContain("http://localhost:4096")

      await writeAttachCheckOutputFile(jsonFile, result, true)
      const jsonContent = await fs.readFile(jsonFile, "utf-8")
      const parsed = JSON.parse(jsonContent)
      expect(parsed.healthy).toBe(true)
      expect(parsed.url).toBe("http://localhost:4096")
      expect(parsed.version).toBe("0.1.0")
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe("AcpServerInfo functions", () => {
  test("builds acp server info and formats text lines", () => {
    const info = buildAcpServerInfo({
      hostname: "127.0.0.1",
      port: 4096,
      cwd: "/home/user/project",
      client: "acp",
      pid: 12345,
    })

    expect(info.url).toBe("http://127.0.0.1:4096")
    expect(info.hostname).toBe("127.0.0.1")
    expect(info.port).toBe(4096)
    expect(info.cwd).toBe("/home/user/project")
    expect(info.client).toBe("acp")
    expect(info.pid).toBe(12345)

    const lines = formatAcpServerInfoText(info)
    expect(lines[0]).toBe("ACP server started")
    expect(lines).toContain("  URL:      http://127.0.0.1:4096")
    expect(lines).toContain("  Host:     127.0.0.1")
    expect(lines).toContain("  Port:     4096")
    expect(lines).toContain("  CWD:      /home/user/project")
    expect(lines).toContain("  PID:      12345")
  })

  test("writes acp server output to file as text and JSON", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-test-"))
    try {
      const textFile = path.join(tempDir, "acp.txt")
      const jsonFile = path.join(tempDir, "acp.json")

      const info = buildAcpServerInfo({
        hostname: "127.0.0.1",
        port: 8080,
        cwd: "/tmp",
        pid: 9999,
      })

      await writeAcpServerOutputFile(textFile, info, false)
      const textContent = await fs.readFile(textFile, "utf-8")
      expect(textContent).toContain("ACP server started")
      expect(textContent).toContain("http://127.0.0.1:8080")

      await writeAcpServerOutputFile(jsonFile, info, true)
      const jsonContent = await fs.readFile(jsonFile, "utf-8")
      const parsed = JSON.parse(jsonContent)
      expect(parsed.port).toBe(8080)
      expect(parsed.pid).toBe(9999)
      expect(parsed.url).toBe("http://127.0.0.1:8080")
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe("checkAttach with mock fetch", () => {
  const getUrl = (input: RequestInfo | URL) => {
    if (typeof input === "string") return input
    if ("url" in input) return input.url
    return String(input)
  }

  test("successfully checks healthy server", async () => {
    const mockFetch = (async (input: RequestInfo | URL) => {
      const url = getUrl(input)
      if (url.endsWith("/global/health")) {
        return new Response(JSON.stringify({ healthy: true, version: "2.0.0" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response("Not found", { status: 404 })
    }) as unknown as typeof fetch

    const result = await checkAttach({
      url: "http://localhost:4096",
      fetch: mockFetch,
    })

    expect(result.healthy).toBe(true)
    expect(result.version).toBe("2.0.0")
    expect(result.error).toBeUndefined()
  })

  test("checks server with session lookup", async () => {
    const mockFetch = (async (input: RequestInfo | URL) => {
      const url = getUrl(input)
      if (url.endsWith("/global/health")) {
        return new Response(JSON.stringify({ healthy: true, version: "2.0.0" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("/session/ses_target123")) {
        return new Response(
          JSON.stringify({
            id: "ses_target123",
            title: "Target Session",
            time: { created: 1000, updated: 2000 },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        )
      }
      return new Response("Not found", { status: 404 })
    }) as unknown as typeof fetch

    const result = await checkAttach({
      url: "http://localhost:4096",
      sessionID: "ses_target123",
      fetch: mockFetch,
    })

    expect(result.healthy).toBe(true)
    expect(result.session).toBeDefined()
    expect(result.session?.id).toBe("ses_target123")
    expect(result.session?.title).toBe("Target Session")
  })

  test("checks server with continue session lookup", async () => {
    const mockFetch = (async (input: RequestInfo | URL) => {
      const url = getUrl(input)
      if (url.endsWith("/global/health")) {
        return new Response(JSON.stringify({ healthy: true, version: "2.0.0" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("/session")) {
        return new Response(
          JSON.stringify([
            {
              id: "ses_continued",
              title: "Continued Session",
              time: { created: 3000, updated: 4000 },
            },
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        )
      }
      return new Response("Not found", { status: 404 })
    }) as unknown as typeof fetch

    const result = await checkAttach({
      url: "http://localhost:4096",
      continueSession: true,
      fetch: mockFetch,
    })

    expect(result.healthy).toBe(true)
    expect(result.continue).toBe(true)
    expect(result.session).toBeDefined()
    expect(result.session?.id).toBe("ses_continued")
    expect(result.session?.title).toBe("Continued Session")
  })

  test("handles connection failure gracefully", async () => {
    const mockFetch = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch

    const result = await checkAttach({
      url: "http://localhost:4096",
      fetch: mockFetch,
    })

    expect(result.healthy).toBe(false)
    expect(result.error).toContain("ECONNREFUSED")
  })
})
