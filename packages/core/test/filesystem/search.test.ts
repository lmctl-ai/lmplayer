import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Ripgrep.node))

const withTmp = <A, E, R>(f: (directory: AbsolutePath) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(AbsolutePath.make(tmp.path))))

describe("Ripgrep", () => {
  it.live("globs files as an array", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).glob({ cwd, pattern: "**/*.ts", limit: 10 })
        expect(result.map((item) => item.path)).toEqual([RelativePath.make("src/match.ts")])
      }),
    ),
  )

  it.live("glob excludes gitignored files by default", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "node_modules", "pkg"), { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src"), { recursive: true }))
        yield* Effect.promise(() => Bun.$`git init -q ${cwd}`)
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, ".gitignore"), "node_modules/\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "node_modules", "pkg", "index.ts"), "ignored\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "index.ts"), "included\n"))
        const result = yield* (yield* Ripgrep.Service).glob({ cwd, pattern: "**/*.ts", limit: 10 })
        expect(result.map((item) => item.path)).toContain(RelativePath.make("src/index.ts"))
        expect(result.map((item) => item.path)).not.toContain(RelativePath.make("node_modules/pkg/index.ts"))
      }),
    ),
  )

  it.live("glob includes ignored files with includeIgnored", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "node_modules", "pkg"), { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src"), { recursive: true }))
        yield* Effect.promise(() => Bun.$`git init -q ${cwd}`)
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, ".gitignore"), "node_modules/\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "node_modules", "pkg", "index.ts"), "ignored\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "index.ts"), "included\n"))
        const result = yield* (yield* Ripgrep.Service).glob({
          cwd,
          pattern: "**/*.ts",
          limit: 10,
          includeIgnored: true,
        })
        expect(result.map((item) => item.path)).toContain(RelativePath.make("src/index.ts"))
        expect(result.map((item) => item.path)).toContain(RelativePath.make("node_modules/pkg/index.ts"))
      }),
    ),
  )

  it.live("greps files with include filtering", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "skip.txt"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).grep({ cwd, pattern: "needle", include: "*.ts", limit: 10 })
        expect(result).toHaveLength(1)
        expect(result[0]?.entry.path).toBe(RelativePath.make("src/match.ts"))
        expect(result[0]?.submatches[0]?.text).toBe("needle")
      }),
    ),
  )
})
