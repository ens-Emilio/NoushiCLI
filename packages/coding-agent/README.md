<p align="center">
  <img alt="Noushi" src="../../assets/noushi.png" width="128">
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square&logo=npm&logoColor=white" /></a>
</p>

> New issues and PRs from new contributors are closed automatically. Maintainers review closed submissions daily. See [CONTRIBUTING.md](https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md).

# Noushi

Noushi is the coding agent shipped by this repository. It uses the pinned upstream Pi implementation while presenting the Noushi name, `noushi` command, and `.noushi` personal data directory. Upstream package names and compatibility settings remain unchanged. See [`NOUSHI.md`](../../NOUSHI.md) for the source pin, license, and reproducible build.

Use Noushi [interactively](docs/usage.md), in [print or JSON mode](docs/cli.md), over [RPC](docs/rpc.md), or through the [TypeScript SDK](docs/sdk.md). These references originate from the upstream Pi documentation; use `noushi` and `.noushi` for this distribution.

## Getting started

Install dependencies and build from the repository root as described in [`NOUSHI.md`](../../NOUSHI.md), then run the CLI in the directory you want it to work in:

```bash
./bin/noushi
``` [packages/coding-agent/README.md#3D21]

Run `/login` to connect a model provider, then enter a task. The CLI supports the same interactive, print, JSON, RPC, and SDK workflows as the pinned upstream implementation.

See the [documentation](docs/index.md) for usage details. For upstream implementation and contribution information, see [earendil-works/pi](https://github.com/earendil-works/pi).

## Development

The CLI implementation is maintained from this repository root. To build and run it locally:

```sh
npm ci
npm run build:noushi
./bin/noushi --help
```

For upstream source, license, and contribution history, see [earendil-works/pi](https://github.com/earendil-works/pi).

## License

MIT
