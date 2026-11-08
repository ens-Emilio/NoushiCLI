import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}
export type SlashCommandOrigin = "noushi" | "omp" | "opencode";

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
	origin?: Exclude<SlashCommandOrigin, "noushi">;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "thinking", description: "Set thinking level", argumentHint: "<level>" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{
		name: "import",
		description: "Import a session; supports Noushi JSONL, Claude Code JSONL, and Aider transcripts",
		argumentHint: "<path> [--format claude-code|aider]",
	},
	{ name: "share", description: "Share session via a Radius artifact or a GitHub gist" },
	{ name: "bug", description: "Report a bug to the upstream Pi project maintainers", argumentHint: "<description>" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{ name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume another session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
	{
		name: "undo",
		description: "Restore the files the last Noushi turn changed, refusing if anything changed outside Noushi",
	},
	{ name: "redo", description: "Show which paths the last undo restored" },
	{ name: "debug", description: "Show TUI diagnostics" },
	{ name: "pin", description: "Pin or unpin a session entry during compaction", argumentHint: "<entry-id> [off]" },
	{
		name: "xomp-model",
		description: "Select a model (OMP compatibility alias)",
		argumentHint: "<provider/model>",
		origin: "omp",
	},
	{ name: "xomp-fork", description: "Fork the current session (OMP compatibility alias)", origin: "omp" },
	{ name: "xomp-new", description: "Start a new session (OMP compatibility alias)", origin: "omp" },
	{ name: "xomp-resume", description: "Resume another session (OMP compatibility alias)", origin: "omp" },
	{ name: "xomp-compact", description: "Compact the session context (OMP compatibility alias)", origin: "omp" },
	{
		name: "xomp-export",
		description: "Export the current session (OMP compatibility alias)",
		argumentHint: "[path]",
		origin: "omp",
	},
	{ name: "xomp-share", description: "Share the current session (OMP compatibility alias)", origin: "omp" },
	{ name: "xomp-copy", description: "Copy the last assistant message (OMP compatibility alias)", origin: "omp" },
	{
		name: "xomp-login",
		description: "Configure provider authentication (OMP compatibility alias)",
		argumentHint: "<provider>",
		origin: "omp",
	},
	{ name: "xomp-logout", description: "Remove provider authentication (OMP compatibility alias)", origin: "omp" },
	{
		name: "xomp-mcp",
		description: "Manage MCP servers (OMP compatibility namespace)",
		argumentHint: "<subcommand>",
		origin: "omp",
	},
	{ name: "xomp-changelog", description: "Show the Noushi changelog (OMP compatibility alias)", origin: "omp" },
	{ name: "xomp-hotkeys", description: "Show keyboard shortcuts (OMP compatibility alias)", origin: "omp" },
	{ name: "xomp-debug", description: "Show TUI diagnostics (OMP compatibility alias)", origin: "omp" },
	{
		name: "xomp-cl",
		description: "Audit release changelog entries (OMP prompt compatibility)",
		origin: "omp",
	},
	{
		name: "xomp-deslop",
		description: "Simplify a completed workpackage (OMP prompt compatibility)",
		origin: "omp",
	},
	{
		name: "xomp-dup",
		description: "Find duplicate GitHub issues (OMP prompt compatibility)",
		argumentHint: "<issue-url>",
		origin: "omp",
	},
	{
		name: "xomp-is",
		description: "Analyze GitHub issues (OMP prompt compatibility)",
		argumentHint: "<issue>",
		origin: "omp",
	},
	{
		name: "xomp-pr",
		description: "Review GitHub pull requests (OMP prompt compatibility)",
		argumentHint: "<PR-URL>",
		origin: "omp",
	},
	{
		name: "xomp-sa",
		description: "Update a GitHub security advisory draft (OMP prompt compatibility)",
		argumentHint: "<advisory-url-or-draft-path>",
		origin: "omp",
	},
	{
		name: "xomp-wr",
		description: "Finish a workpackage (OMP prompt compatibility; may commit and push)",
		argumentHint: "[instructions]",
		origin: "omp",
	},
	{
		name: "xopencode-compact",
		description: "Compact the current session (OpenCode compatibility alias)",
		origin: "opencode",
	},
	{
		name: "xopencode-thinking",
		description: "Set thinking visibility (OpenCode compatibility alias)",
		origin: "opencode",
	},

	{ name: "quit", description: `Quit ${APP_NAME}` },
];
