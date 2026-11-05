# Noushi baseline

NoushiCLI is based on the `earendil-works/pi` monorepo at revision [`676af1d777ef6f04b6bc8daf4cf3b9b1799cff4d`](https://github.com/earendil-works/pi/tree/676af1d777ef6f04b6bc8daf4cf3b9b1799cff4d), dated 2026-11-03. The upstream engine package version is `1.5.0`; the Noushi product version is `0.1.0`. The upstream MIT license is preserved in `LICENSE`.

## Local identity delta

- `piConfig.name` is `Noushi`; the command is `noushi`.
- `piConfig.configDir` is `.noushi`; default personal config, credentials, and session data use `~/.noushi`.
- `piConfig.version` is the product version `0.1.0`. The coding-agent package and runtime workspace remain at upstream-compatible `1.5.0`.
- The terminal header and TUI use the geometric Noushi identity.
- Upstream package identifiers (`@earendil-works/pi-*`), protocol/API compatibility, attribution, and `PI_*` environment variables remain unchanged intentionally.

## Build and execution

Requires Node.js `>=22.19.0` and npm. From this repository root:

```sh
npm ci
npm run build:noushi
./bin/noushi --help
./bin/noushi --version
```

`build:noushi` builds workspace packages and the unbundled CLI for local development. It requires the checkout's installed dependencies. `npm run build` also invokes the complete esbuild bundle and is the release candidate path. A successful unbundled build does not establish a standalone package. Do not claim distribution parity until the bundled build and a packed installation outside this checkout both pass.

Link the workspace executable for local development with `npm link --workspace @earendil-works/pi-coding-agent`; unlink with npm's standard unlink operation. `bin/noushi` resolves the repository root from its own path, including when invoked through a symlink.

## Upstream changes and differences

This directory is the complete pinned upstream workspace rather than a path dependency of NoushiCode. It includes the monorepo's packages, scripts, schemas, tests, examples, documentation, and upstream release/changelog files. `README.md` is replaced with NoushiCLI setup and development instructions; this file records the baseline and local delta. No generated `dist`, dependency tree, or cache is part of the source baseline.

The upstream README and package documentation are retained where they describe engine behavior and APIs; their upstream package names and attribution are intentional. Product-facing commands and paths are documented here and in the root README. Update the pin and this delta together when importing a newer upstream revision.

## Release status and build validation

The previously reported release blocker, `Bundle left unexpected external imports: <runtime>`, was investigated and resolved:
1. `<runtime>` was an error-reporting string literal inside `agent-session.ts`, not an external import statement.
2. The full bundled release build (`npm run build`) was executed in this isolated repository and succeeded without warnings or unexpected externals, producing `packages/coding-agent/dist/bundle` (83 files, 9.3 MiB).
3. Local checkout execution via `./bin/noushi` is validated and fully operational. Packaging into tarballs is implemented by `npm run pack:packages`.
No published Noushi package, installer, or self-update feed is configured here. The supported usage at this baseline is a local checkout and launcher; do not advertise upstream `pi update` infrastructure as a Noushi release channel.
