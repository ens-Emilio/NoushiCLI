# LSP Tool

`createLspTool(cwd, options)` in `src/core/tools/lsp.ts` creates a callable `lsp` tool. It starts the configured language server for each invocation and communicates over stdio using LSP JSON-RPC framing. No server dependency is bundled; install/configure the desired server separately.

`LspToolOptions` requires `command` and optionally accepts process `args` and a `languageId` override. Each call requires `operation` (`definition`, `references`, or `diagnostics`) and a `file` path relative to the working directory. Definition and references accept optional 1-based `line` and `character` values, defaulting to the start of the file. Diagnostics waits up to five seconds for `textDocument/publishDiagnostics`.

Example:

```ts
import { createLspTool } from "./core/tools/lsp.ts";

const lsp = createLspTool(process.cwd(), {
  command: "typescript-language-server",
  args: ["--stdio"],
  languageId: "typescript",
});
```

The tool initializes the server, opens the requested file, sends the selected LSP request, then sends `shutdown` and `exit`. Aborting execution terminates the child process.
