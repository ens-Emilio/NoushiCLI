# Advanced tools

The default coding toolset includes `process`, `ast_edit`, and `sqlite_inspect` alongside the standard file and shell tools. LSP is opt-in through the SDK `ToolsOptions.lsp` configuration, which requires a language-server command.

- `process` poll accepts optional `waitMs` (up to 30 seconds), returning when output arrives, the process exits, or the wait expires; this avoids rapid polling while waiting for long-running work.
- `ast_edit` uses the TypeScript compiler parser to replace a uniquely named top-level declaration in TS/JS source. It is not a text/regex substitute: ambiguous names and invalid replacement syntax are rejected.
- `sqlite_inspect` opens the database read-only and accepts one `SELECT`, `WITH`, or `PRAGMA` statement. It requires a Node runtime that provides `node:sqlite` (Node 22.19 runtime support depends on the binary; unsupported runtimes report an error).
- Shell commands may request `{ "sandbox": true }` explicitly. Linux requires `bwrap`; macOS requires `sandbox-exec` (Seatbelt). Missing facilities and unsupported platforms fail closed; ordinary commands are not represented as sandboxed.

The shell tool already propagates cancellation to the shell process tree. The advanced process tool uses the same cancellation intent for a spawned background process. OS sandboxing is a best-effort opt-in boundary; use a dedicated container or VM for stronger isolation.
