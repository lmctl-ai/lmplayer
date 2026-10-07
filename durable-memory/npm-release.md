# lmplayer npm releases

The fork workflow is `.github/workflows/lmplayer-publish.yml`. Pushes to `dev`
build all 12 CLI targets and publish directly to `latest`. Manual dispatch defaults to
build-only (`dry_run: true`). Package name/channel are in `script/lmplayer-release.json`.
This workflow never calls the inherited upstream publisher.

## Artifacts and checks

The npm wrapper is `@lmctl-ai/lmplayer`; its exact-version optional dependencies
are the 12 `@lmctl-ai/lmplayer-<target>` packages. The wrapper selects the correct
OS, CPU capability, and libc. No postinstall hook is needed.

Targets are Linux ARM64/x64, x64 baseline, and their musl variants; macOS and
Windows ARM64/x64 and x64 baseline. All targets must pass before publication.
Native runners execute version/help checks; musl binaries run in Alpine.
Windows binaries are cross-compiled on Linux, then executed on Windows runners;
this avoids Bun's Windows patch-cache installation failures for the dev workspace.
One models.dev snapshot is shared across the matrix for a consistent release.
Only the binary, manifest, and license are packed; the wrapper ships its launcher.

The workflow allocates one version for the full matrix, considering existing
platform packages too. Platform packages publish first and the wrapper last.
Use GitHub's **Re-run failed jobs** to retry publishing with the same successful
plan/build artifacts. A full workflow rerun is a new build and allocates a fresh
version; do not expect rebuilt executables to be byte-identical. Publishing accepts
an existing version only when its integrity matches, and refuses to move the
wrapper's channel backward.
Registry visibility/install checks retry reads, never republish as a delay fix.

## npm authorization

These are new npm package names. The first real release must establish them with
an authenticated npm maintainer; a dry run only produces downloadable artifacts.
Use the complete `npm-release-packages` artifact plus its matching release plan.
Do not create empty placeholder packages or run the upstream publishing scripts.

For ongoing tokenless publishing, configure an npm trusted publisher on **each**
of the 13 packages: repository `lmctl-ai/lmplayer`, workflow `lmplayer-publish.yml`,
no environment, direct publishing allowed. This public repo publishes provenance.
Alternatively, `NPM_PUBLISH_TOKEN` may be supplied as an Actions secret with access
to this package family. A token restricted to `@lmctl-ai/lmctl` does not authorize
these different packages. Do not copy unrelated credentials or expose token values.

Once publication is verified, install with:

```sh
npm install -g @lmctl-ai/lmplayer
lmplayer --version
```

There is no staging or promotion gate currently. The build embeds the same channel
as the npm tag, both read from the release configuration. Staging can be added later.

## Local checks

```sh
cd packages/opencode
bun test --timeout 30000 test/installation/build-target.test.ts test/installation/npm-package.test.ts test/installation/npm-release.test.ts
bun typecheck
```

The complete release plan and tarballs are under `.lmplayer-release/` (ignored).
The supported target list comes from `packages/opencode/script/build-target.ts`.
