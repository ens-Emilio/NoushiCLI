// Resolve explicit OMP and OpenCode aliases without making them authoritative over Noushi commands.
export type SlashCommandCompatibilityOrigin = "omp" | "opencode";

export type SlashCommandCompatibilityAction =
	| {
			kind: "alias";
			origin: SlashCommandCompatibilityOrigin;
			command: string;
			argumentsText: string;
			/** Literal arguments prepended to the user's arguments, such as a default export path suffix. */
			argumentsPrefix?: string;
	  }
	| { kind: "toggle-thinking"; origin: "opencode" };

const aliases: Readonly<
	Record<string, { origin: SlashCommandCompatibilityOrigin; command: string; argumentsPrefix?: string }>
> = {
	"xomp-model": { origin: "omp", command: "model" },
	"xomp-fork": { origin: "omp", command: "fork" },
	"xomp-new": { origin: "omp", command: "new" },
	"xomp-resume": { origin: "omp", command: "resume" },
	"xomp-compact": { origin: "omp", command: "compact" },
	"xomp-cl": { origin: "omp", command: "cl" },
	"xomp-deslop": { origin: "omp", command: "deslop" },
	"xomp-dup": { origin: "omp", command: "dup" },
	"xomp-is": { origin: "omp", command: "is" },
	"xomp-pr": { origin: "omp", command: "pr" },
	"xomp-sa": { origin: "omp", command: "sa" },
	"xomp-wr": { origin: "omp", command: "wr" },
	"xomp-share": { origin: "omp", command: "share" },
	"xomp-copy": { origin: "omp", command: "copy" },
	"xomp-login": { origin: "omp", command: "login" },
	"xomp-logout": { origin: "omp", command: "logout" },
	"xomp-mcp": { origin: "omp", command: "mcp" },
	"xomp-changelog": { origin: "omp", command: "changelog" },
	"xomp-hotkeys": { origin: "omp", command: "hotkeys" },
	"xomp-debug": { origin: "omp", command: "debug" },
	"xopencode-compact": { origin: "opencode", command: "compact" },
};

/** Alias table for tests and autocomplete wiring: every target must be a real Noushi command. */
export const slashCommandCompatibilityAliases = aliases;

/** Resolve a namespaced command only where its behavior matches a current Noushi command. */
export function resolveSlashCommandCompatibility(text: string): SlashCommandCompatibilityAction | undefined {
	const match = /^\/(xomp-[^\s]+|xopencode-[^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
	if (!match) return undefined;
	const name = match[1]!;
	const argumentsText = match[2] ?? "";
	if (name === "xopencode-thinking" && argumentsText.length === 0) {
		return { kind: "toggle-thinking", origin: "opencode" };
	}
	const alias = aliases[name];
	if (!alias) return undefined;
	const prefix = alias.argumentsPrefix ? `${alias.argumentsPrefix} ` : "";
	return {
		kind: "alias",
		origin: alias.origin,
		command: alias.command,
		argumentsText: `${prefix}${argumentsText}`.trim(),
	};
}
