# Deferred External CLI Tools

The following tools are intentionally not implemented in the safe parse-as-is linux tool batch:

- `bun`
- `npm`
- `pnpm`
- `yarn`
- `docker`

Reason: these tools can execute untrusted project code or container entrypoints from argv and local configuration. They need a separate policy design instead of the read/search/archive/network wrappers added in this batch.
