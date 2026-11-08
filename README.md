<p align="center">
  <img alt="Noushi" src="assets/noushi.png" width="128">
</p>

# Noushi CLI

Noushi is an advanced, extensible coding agent harness for the terminal. Built for developers who want full control over their workflows, Noushi provides interactive terminal UI (TUI), single-shot print and JSON/NDJSON streams, headless RPC daemon execution, and a modular TypeScript SDK.

The project is pinned to the upstream `earendil-works/pi` engine (revision `676af1d777ef6f04b6bc8daf4cf3b9b1799cff4d`, engine version `1.5.0`) with dedicated Noushi branding (`v0.1.0`), isolated `.noushi` configuration directories, and 50 extended engineering features covering security governance, terminal UX, specialized tooling, model cost management, context pinning, and interop protocols.

---

## Key Features

- **Terminal UX & Ergonomics:**
  - Interactive unified ANSI diff preview before disk modification (`ctx.ui.confirm`).
  - Split-view filesystem panel (`app.filesystem.toggle`) for browsing repo trees directly in the terminal.
  - Persistent prompt history with reverse search (`Ctrl+R`) stored securely in `~/.noushi/agent/prompt-history.json` (`0600`).
  - Configurable keyboard modes (Emacs shortcuts and Vim normal/insert toggling).
  - Intelligent log and output folding (`Ctrl+O`).
  - Real-time telemetry status bar displaying context window %, token metrics, cumulative cost ($ USD), and active tool.

- **Security, Governance & Safety:**
  - Preventative secret filtering: automatic blockage of sensitive files (`.env*`, private SSH keys, `.pem`, `.key`, `credentials.json`) across `read`, `write`, `edit`, `grep`, `find`, and shell read commands (`cat`, `head`, `tail`, `grep`, `rg`).
  - Destructive command guard: interactive confirmation for `rm -rf`, `git reset --hard`, `git clean -f`, `mkfs`, `dd`.
  - Append-only audit logging: records blocked and confirmed security events in `~/.noushi/agent/audit.log` without leaking file contents or passwords.
  - Turn-scoped Git checkpoint & rollback: `/rollback` restores only tracked files modified by Noushi during the active turn without discarding external user changes.
  - Native OS Keyring: secure credential storage via macOS Keychain and Linux Secret Service (`secret-tool`).
  - Heuristic prompt injection detection: analyzes read file contents and attaches warnings without altering source text.

- **Tools & Execution:**
  - AST-aware code editing (`ast_edit`): semantic replacement of functions, classes, and variable declarations via Acorn parser.
  - Embedded Language Server Protocol (`lsp`): stdio JSON-RPC client providing definitions, references, and diagnostics.
  - Background process management (`process`): start, poll (with bounded `waitMs`), and stop long-running commands.
  - Read-only SQLite inspector (`sqlite_inspect`): safe read-only SQL queries (`PRAGMA query_only = ON`).
  - OS-level shell sandboxing (`bwrap` on Linux, `sandbox-exec` on macOS).

- **Models, Routing & Cost Governance:**
  - Budget ceiling (`--max-cost <usd>`): stops agent requests when cumulative session cost exceeds a threshold.
  - Transparent model routing and opt-in fallback on HTTP 429 / 5xx rate limits.
  - Local endpoint compatibility: zero-config support for Ollama and vLLM via OpenAI-compatible endpoints (`http://localhost:11434/v1`).
  - Enterprise mTLS and proxy CA certificate configuration (`httpCaPath`, `httpClientCertPath`, `httpClientKeyPath`).
  - Tool result compaction: automatic truncation of historical tool payloads in long sessions to preserve context.

- **Context & Session Management:**
  - Context turn pinning (`/pin <entry-id> [off]`): immunizes critical instructions and architecture decisions against compaction.
  - External session import (`/import <path> [--format claude-code|aider]`): converts and validates transcripts from Claude Code and Aider into native Noushi JSONL sessions.
  - Strict code review mode (`--review`): restricts execution exclusively to read-only tools and safe read commands.
  - Multi-root workspaces: supports `.noushi-workspace.json` for loading context across multiple project repositories.

- **Extensibility & Protocols:**
  - Private Unix socket RPC daemon (`--socket <path>`): bi-directional IPC server with `0600` permissions and multi-client subprocess bridging.
  - MCP tool schema validation: client-side argument validation against JSON Schemas before dispatching tool calls.
  - Extension integrity verification: SHA-256 digest validation (`pi.integrity`) before loading third-party extensions.
  - Changed-file pre-commit validation: runs configured test/lint commands strictly against Git-modified paths.

---

## Requirements

- **Node.js:** `>=22.19.0`
- **npm:** `>=10.0.0`
- **Git**

---

## Installation & Setup

Clone the repository and install dependencies:

```sh
git clone https://github.com/ens-Emilio/NoushiCLI.git
cd NoushiCLI
npm ci
```

### Build

Compile the workspace packages:

```sh
# Local development build (unbundled TypeScript)
npm run build:noushi

# Full standalone release build (bundled via esbuild)
npm run build
```

---

## Usage

Run Noushi using the local launcher:

```sh
# Verify installation
./bin/noushi --version   # returns 0.1.0
./bin/noushi --help

# Start interactive TUI mode
./bin/noushi

# Start in a specific directory with initial instructions
./bin/noushi "Review the authentication module and list issues"

# Read-only code review mode
./bin/noushi --review -p "Audit src/core for security vulnerabilities"

# Set a budget ceiling (stops after $0.50 USD)
./bin/noushi --max-cost 0.50

# Serve RPC over a Unix Domain Socket
./bin/noushi --socket /tmp/noushi.sock
```

### Linking Globally

To use `noushi` from anywhere on your system:

```sh
npm link --workspace @noushi/cli
```

Ensure your global npm bin directory is in your `$PATH`.

---

## Development & Testing

```sh
# Run typechecks
npx tsc --noEmit -p packages/coding-agent/tsconfig.build.json

# Run unit and integration tests
npm test

# Run focused feature suites
node ./node_modules/vitest/dist/cli.js run packages/coding-agent/test/security-policy.test.ts

# Package validation outside the repository
npm run pack:packages
npm run release:local
```

---

## Configuration & Paths

- **User Config:** `~/.noushi/agent/settings.json`
- **Authentication & Keys:** `~/.noushi/agent/auth.json` (or native Keyring)
- **Sessions:** `~/.noushi/agent/sessions/`
- **Prompt History:** `~/.noushi/agent/prompt-history.json`
- **Audit Logs:** `~/.noushi/agent/audit.log`
- **Project Overrides:** `.noushi/settings.json` or `AGENTS.md` in repository root.

---

## License & Attribution

Distributed under the [MIT License](LICENSE).

Noushi is built upon the open-source Pi coding agent engine created by Mario Zechner. Technical identifiers, internal package names (`@earendil-works/pi-*`), and compatibility environment variables are preserved in accordance with the upstream MIT license. See [NOUSHI.md](NOUSHI.md) for detailed revision baselines and rebrand specifications.
