const READ_ONLY_COMMANDS: Record<string, true> = {
	cat: true,
	git: true,
	grep: true,
	head: true,
	ls: true,
	pwd: true,
	rg: true,
	stat: true,
	tail: true,
};
const SHELL_CONTROL = /[|;&<>`(){}\n\r]/u;

/** Return whether a single shell command uses an explicitly read-only executable and operation. */
export function isReviewSafeShellCommand(command: string): boolean {
	const input = command.trim();
	if (!input || SHELL_CONTROL.test(input) || input.includes("$")) return false;
	const tokens = input.split(/\s+/u);
	const executable = tokens[0].split(/[\\/]/u).at(-1)?.toLowerCase();
	if (!executable || READ_ONLY_COMMANDS[executable] !== true) return false;
	if (executable !== "git") return true;
	const gitCommand = tokens[1]?.toLowerCase();
	return gitCommand === "status" || gitCommand === "diff" || gitCommand === "log" || gitCommand === "show";
}

/** Built-in tools that do not mutate project files or execute arbitrary code. */
export const REVIEW_ALLOWED_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
