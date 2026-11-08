# Slash commands

Type `/` in Noushi's terminal editor to search the commands available in the current session. This page lists built-in commands.

Extensions, prompt templates, and skills can add commands. The command menu shows the resources loaded in the current session.

## Models and settings

| Command | Description |
|---|---|
| `/settings` | Open settings |
| `/model [provider/model]` | Select a model |
| `/thinking [level]` | Set the thinking level |
| `/scoped-models` | Configure the models used by interactive cycling |
| `/login [provider]` | Add provider authentication |
| `/logout` | Remove provider authentication |
| `/llama` | Manage models on the configured llama.cpp router |

## Sessions and context

| Command | Description |
|---|---|
| `/undo` | Restore the files the last Noushi turn changed, refusing if anything changed outside Noushi |
| `/redo` | Show which paths the last undo restored |
| `/new` | Start a new session |
| `/resume` | Resume another session |
| `/name [name]` | Set the session display name, or show the current name when omitted |
| `/session` | Show current session information and statistics |
| `/tree` | Navigate the session tree |
| `/fork` | Create a new session from an earlier user message |
| `/clone` | Duplicate the current session at its current position |
| `/compact [instructions]` | Compact the current context, optionally with custom instructions; pinned context is retained live |
| `/pin <entry-id> [off]` | Keep a context entry live through future compactions, or remove its pin |
| `/import <path> [--format claude-code|aider]` | Validate and import Noushi JSONL, Claude Code JSONL, or Aider chat history; external formats are converted to a new Noushi session |

## Export and share

| Command | Description |
|---|---|
| `/copy` | Copy the last assistant message |
| `/export [path]` | Export the session as HTML or JSONL |
| `/share` | Upload the session and return a viewer link |
| `/bug [description]` | Prepare a private bug report for the Pi developers |

Review a session before exporting or sharing it. Sessions can contain prompts, tool arguments, command output, file contents, and credentials exposed during the conversation.

## Runtime and project

| Command | Description |
|---|---|
| `/trust` | Save a project trust decision for future Pi processes |
| `/mcp` | Manage MCP servers: sign in, reconnect, enable or disable, and change exposure |
| `/reload` | Reload keybindings, extensions, skills, templates, themes, and context files |
| `/hotkeys` | Show active keyboard shortcuts |
| `/changelog` | Show changelog entries |
| `/quit` | Quit Pi |

## Project context and review

Project instructions are loaded from the global configuration directory followed by ancestor directories, with deeper instructions later in prompt context. `AGENTS.override.md` takes precedence over other supported context filenames within one directory; linked worktrees avoid loading the corresponding main-worktree context twice.

An optional `.noushi-workspace.json` in the current directory may add instruction roots:

```json
{"folders":["packages/api","../shared-guides"]}
```

Folders are resolved relative to the workspace file, must exist as directories, and contribute their layered context files after the current-root context. Invalid entries are ignored with a warning. `--review` is intended for read-only review sessions; it disables write/edit and restricts shell to read-only commands, but is not an OS sandbox and does not constrain extensions.

## Commands added by resources

- Extensions can register commands with their own arguments and completion behavior.
- Each prompt template is available under its template name.
- Skills are available as `/skill:name` when skill commands are enabled.

Use `/reload` after adding or changing a discovered command resource. See [Extensions](extensions.md), [Prompt Templates](prompt-templates.md), and [Skills](skills.md) for their loading and naming rules.

## OMP and OpenCode compatibility

Compatibility commands use separate namespaces so they cannot shadow Noushi commands. The local subset is backed by existing APIs; commands that require an unsupported backend are not registered.

| Command | Description |
|---|---|
| `/xomp-context` | Show current context-window token usage and percentage, or report that usage is unavailable |
| `/xomp-session [info]` | Show the current session ID, display name, and entry count |
| `/xomp-tools` | List tools currently active for the model |
| `/xomp-handoff [instructions]` | Record a reviewed handoff note in the session |
| `/xomp-queue` | Show pending steering and follow-up messages |
| `/xomp-retry` | Re-send the most recent failed prompt when the last turn errored |
| `/xomp-todo <list\|add\|done\|rm\|export\|import> [value]` | Manage todos persisted as session entries; export/import require an interactive trusted project and overwrite confirmation |
| `/xomp-loop <1-10> <prompt>` | Repeat a prompt up to ten times while the session stays idle and each turn succeeds |
| `/xomp-goal <set\|show\|pause\|resume\|drop\|complete\|budget> [value]` | Persist a session goal, inject it into model context, and enforce its budget as a session cost cap |
| `/xomp-plan <objective>` | Start a plan: mutating tools are disabled and the objective joins every prompt |
| `/xomp-plan-review` | Edit the plan, then restore the previous tool selection on confirmation |
| `/xomp-dirs` / `/xomp-add-dir` / `/xomp-remove-dir` | List and manage `.noushi-workspace.json` context folders (trusted projects only) |
| `/xopencode-help` | Open a Markdown listing of every command in the current session, grouped by source |
| `/xopencode-init` | Draft or update `AGENTS.md` with a diff preview and explicit confirmation (trusted projects) |
| `/xomp-cl` … `/xomp-wr` | Bundled OMP workflow prompts (`cl`, `deslop`, `dup`, `is`, `pr`, `sa`, `wr`) with pinned-revision provenance in their frontmatter |
| `/xomp-goal` | Manage a session-persisted goal and enforce its optional USD session-cost cap |
| `/xomp-guided-goal <objective>` | Refine a rough objective through up to five optional prompts, review, then set the session goal |
| `/xomp-vibe <objective>` | Set a goal and enter read-only planning in one step; `/xomp-plan-review` completes both |
| `/xomp-plan` / `/xomp-plan-review` | Inject a persisted plan into request context; disable mutating tools, then review and restore tools |
| `/xomp-fast [on\|off\|status]` | Set `reasoning.effort = "low"` on provider requests that expose it; status only reports state |
| `/xomp-extended-context [status]` | Report catalog context-window metadata; entitlement cannot be enabled from the CLI |
| `/xomp-vision <on\|off\|auto\|status>` | Toggle image visibility in model context and report catalog image-input support |
| `/xomp-move <file-name>` | Rename the current session file within its directory (overwrite requires confirmation) |
| `/xomp-clear` | Confirm, then clear queued messages and compact the context; transcript history stays on disk |
| `/xomp-drop [id-prefix]` | Delete a stored session file after selecting it and typing its id; refuses the active session |
| `/xomp-force <tool> <prompt>` | Run one tool call outside a model turn after confirmation; the result is recorded in the transcript |
| `/xomp-btw <question>` | One-turn side question: visible to the model for exactly the request it starts |
| `/xomp-shake <elide\|images\|thinking>` | Preview and confirm context edits that omit or shorten projected entries; history is never deleted |
| `/xomp-tan <work>` | Start background work in a child session (at most 3 concurrent) |
| `/xomp-jobs [list\|cancel\|result\|wait] [id]` | Inspect, cancel, or read background job results |
| `/xomp-cleanse [--all]` | Dispatch one background fix per error in the last turn's tool results |
| `/xomp-omfg <correction>` / `list` / `forget <id>` | Persist a correction injected into future context; global scope asks for consent |
| `/xomp-plugins [list\|install\|remove]` | Manage packages through the existing package manager; no automatic trust |
| `/xomp-marketplace <search\|install>` | Search the npm registry read-only or install through the package manager |
| `/xomp-memory [view\|stats\|remember\|recall\|forget]` | Durable project-scoped memory in SQLite with FTS recall; remember and forget require confirmation |
| `/xomp-security [scan\|export <file>]` | Local rule-based secret/injection scanner producing SARIF 2.1.0; cloud and import subcommands are unavailable |
| `/xomp-browser [status\|open\|navigate\|eval\|screenshot\|close]` | Drive a self-launched Chromium over CDP with an isolated profile; launch requires consent |
| `/xomp-ssh [list\|add\|remove\|help]` | Store SSH host metadata (alias, host, user, port, identity path); keys stay at their own paths and remote execution is unavailable |
| `/xomp-ssh run <alias> <command>` | Run one command over the system ssh after per-command consent; allowlist/denylist per host, output capped, batch mode only |
| `/xomp-ssh allow\|deny <alias> <prefix>` | Manage a host's command allowlist/denylist prefixes |
| `/xomp-security plan [id]` / `import <file.sarif>` / `compare <plan-id>` | Persist scans as plans, import external SARIF 2.1.0 with path confinement, and report unchanged/new/fixed by content fingerprint |
| `/xomp-advisor [on\|off\|status\|ask\|dump]` | Second-model advisor role with its own transcript projection and usage metering; idle-only |
| `/xomp-prewalk <input>` | One-shot second-model pass over an input; the role is disposed after the answer |
| `/xomp-computer` / `/xomp-live` | Report input-automation and audio-capture capabilities honestly; execution stays unavailable |
| `/xomp-collab [start\|status\|stop]` | Host a collaboration room over a relay; guests are approved per join |
| `/xomp-join <invite>` / `/xomp-leave` | Join a room with an invite link and leave it; observers cannot send |
| `/xopencode-<alias>` | Explicit aliases reuse Noushi commands: `compact`, `thinking` |

OpenCode Markdown commands load from `~/.noushi/agent/commands/` and trusted-project `.noushi/commands/`. Project commands are ignored until that project is trusted. Frontmatter is validated; argument placeholders and cwd-confined `@file` references are expanded. Shell interpolation requires explicit `shell: true`, but still fails because no callable trusted shell-confirmation path exists. `agent`, `model`, and `subtask` metadata fail explicitly because those execution semantics are not available. See [the adoption plan](../../../SLASH-COMMANDS-ADOPTION-PLAN.md) for upstream revisions, unsupported command families, and prerequisites.

These are extension commands: fully visible in interactive mode, with notifications delivered as `extension_ui_request` events in RPC mode. In print and JSON modes the extension UI is a no-op, so their informational output is not printed; unsupported requests still fail with errors.
