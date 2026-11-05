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
