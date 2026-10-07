# npm publishing setup

## Destination and behavior

- Repository: `lmctl-ai/lmplayer`; local checkout: `/home/mma/repos/providers/lmplayer`.
- npm maintainer: `mikema3`. GitHub account: `mike-lmctl`.
- Pushes to `dev` run `.github/workflows/lmplayer-publish.yml`. Successful builds
  publish directly to **latest**, per operator direction. There is no staging gate.
- Manual dispatch defaults to `dry_run: true`: build/test/package without publishing.
- `script/lmplayer-release.json` owns the npm name and channel. The workflow passes
  that channel into compilation too. The inherited upstream publisher is not used.

## What ships

`@lmctl-ai/lmplayer` is a small JavaScript launcher with 12 exact-version optional
dependencies, named `@lmctl-ai/lmplayer-<target>`. Each contains a standalone Bun
executable compiled from the TypeScript application, plus its manifest and license.
Users install only the wrapper; they do not need Bun or Node for the native binary
itself, but the npm launcher requires Node 18 or newer.

Targets: Linux ARM64/x64/x64-baseline, each with glibc and musl variants; macOS and
Windows ARM64/x64/x64-baseline. The launcher selects OS, CPU capability, and libc.

The workflow allocates one version beyond existing platform/wrapper versions,
shares one models.dev snapshot, runs release tests and a CLI typecheck, builds all
targets, and checks version/help on matching platforms (Alpine for musl).
Windows is cross-compiled on Linux and executed on native Windows runners. This
avoids Bun's Windows dependency patch-cache failures. Windows extraction uses the
system `tar.exe` because Git Bash tar misreads drive letters as remote hosts.

All checks must pass before publication. Native packages publish first; the wrapper
publishes last. Verification compares registry integrity against the exact tarballs,
installs the wrapper from npm, and executes version/help. Registry delays trigger
read/install retries for up to 30 minutes, not repeated publication.

## Authentication and one-time bootstrap

GitHub repository ownership does not authenticate to npm. `npm whoami` confirms a
local login, but npm can still require a separate browser verification for publishing
or modifying trusted publishers. In this bootstrap, requests were separate per
package and per trust configuration; unused verification links expired.

1. Operator authenticates locally with
   `npm login --auth-type=web --registry=https://registry.npmjs.org/`.
2. Use a successful run's **npm-release-packages** artifact and its matching
   **lmplayer-release-plan** artifact. Bootstrap real packages from these tested
   tarballs; do not create placeholders or mix artifacts from different runs.
3. For every package, including the wrapper, configure:

   ```sh
   npm trust github <package-name> --repo lmctl-ai/lmplayer \
     --file lmplayer-publish.yml --allow-publish --yes
   ```

   No GitHub environment is configured. The operator completes npm's browser
   challenges when requested. `--yes` accepts CLI confirmation; it does not remove 2FA.
4. Verify a GitHub Actions publication. Its `id-token: write` permission and npm 11
   allow OIDC trusted publishing with provenance, without a stored npm token or a
   local login. Trust must exist on all 13 packages before setup is complete.

The workflow also supports an optional `NPM_PUBLISH_TOKEN` secret, but none was
installed for this setup. Do not copy unrelated package tokens. Never document or
commit credentials, npm configuration containing tokens, or temporary auth links.

## Resume and verification

Use **Re-run failed jobs** to keep the successful plan and exact built artifacts.
A full rerun/new push allocates a new version. Existing versions are accepted only
if their tarball integrity matches; never overwrite a version with rebuilt bytes.
Local release artifacts and bootstrap logs live in ignored `.lmplayer-release/`.

```sh
gh run list -R lmctl-ai/lmplayer --workflow lmplayer-publish.yml
npm view @lmctl-ai/lmplayer dist-tags --registry=https://registry.npmjs.org/
npm install -g @lmctl-ai/lmplayer
lmplayer --version
```

Code and routine checks are linked in [npm-release.md](npm-release.md).

## Verified setup — 2026-10-07 UTC

Bootstrap is complete. All 13 packages have GitHub trusted publishers configured;
no npm token secret was installed. The operator completed npm's one-time browser
verifications for initial publications and trust settings.

Run [37569201643](https://github.com/lmctl-ai/lmplayer/actions/runs/37569201643)
built all 12 targets, passed native smoke checks, and published all 13 packages at
**1.18.27/latest** through GitHub OIDC with provenance. Its final successful retry
verified exact tarball integrity for every package and installed and executed the
npm wrapper (`--version` and `--help`). Normal pushes to `dev` now require no npm
login or browser approval, provided the trust settings remain in place.

The original 10-minute verification window expired while npm processed the last
Windows package. Retrying the same job after registry visibility caught up passed;
no new version or browser approval was needed. Verification now allows 30 minutes.
Use read-only retries for this delay, and confirm the full workflow is green.

The early 1.18.25 partial staging bootstrap is historical. Current releases go
directly to latest. Consult npm and Actions for versions newer than this checkpoint.
