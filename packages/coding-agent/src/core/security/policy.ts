import { basename } from "node:path";

const SENSITIVE_FILENAME_PATTERNS = [
	/^\.env(?:\..+)?$/i,
	/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
	/^credentials(?:\.json)?$/i,
	/\.(?:pem|key|p12|pfx|kdbx)$/i,
];

export function isSecretPath(path: string): boolean {
	return SENSITIVE_FILENAME_PATTERNS.some((pattern) => pattern.test(basename(path)));
}

const SECRET_READ_COMMANDS: Record<string, true> = {
	cat: true,
	head: true,
	tail: true,
	sed: true,
	awk: true,
	less: true,
	more: true,
	grep: true,
	rg: true,
};

/** Detects secret-file arguments to explicit shell read commands without rejecting unrelated operations. */
export function isSecretReadCommand(command: string): boolean {
	const segments: string[][] = [[]];
	let word = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let uncertain = false;
	const segmentUncertainty: boolean[] = [];
	const pushWord = () => {
		if (word) segments.at(-1)!.push(word);
		word = "";
	};
	for (let index = 0; index < command.length; index++) {
		const char = command[index]!;
		if (escaped) {
			word += char;
			escaped = false;
			continue;
		}
		if (quote === "'") {
			if (char === "'") quote = undefined;
			else word += char;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = undefined;
			else if (char === "\\") escaped = true;
			else {
				if (char === "$" || char === "`") uncertain = true;
				word += char;
			}
			continue;
		}
		if (char === "'" || char === '"') quote = char;
		else if (char === "\\") escaped = true;
		else if (char === " " || char === "\t" || char === "\r") pushWord();
		else if (char === "\n" || char === ";" || char === "|" || char === "&") {
			pushWord();
			if (char !== "\n") while (command[index + 1] === char) index++;
			segmentUncertainty.push(uncertain);
			uncertain = false;
			segments.push([]);
		} else {
			if (char === "$" || char === "`") uncertain = true;
			word += char;
		}
	}
	pushWord();
	if (quote || escaped) uncertain = true;
	segmentUncertainty.push(uncertain);
	for (const [index, words] of segments.entries()) {
		const commandIndex = words.findIndex((value) => !value.startsWith("-") && !value.includes("="));
		if (commandIndex < 0) continue;
		const executable = words[commandIndex]!.split("/").at(-1)!;
		if (!(executable in SECRET_READ_COMMANDS)) continue;
		const args = words.slice(commandIndex + 1);
		const fileArgs = executable === "grep" || executable === "rg" ? args.slice(1) : args;
		if (
			segmentUncertainty[index] ||
			fileArgs.some(
				(value) => isSecretPath(value) || value.includes("*") || value.includes("?") || value.includes("["),
			)
		)
			return true;
	}
	return false;
}

const DESTRUCTIVE_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{
		pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+|--force\s+|--recursive\s+)/,
		reason: "Forced or recursive file removal (rm -rf)",
	},
	{ pattern: /\bgit\s+reset\s+--hard\b/, reason: "Uncommitted work destruction (git reset --hard)" },
	{ pattern: /\bgit\s+clean\s+(-[a-zA-Z]*f|--force)\b/, reason: "Untracked file deletion (git clean -f)" },
	{ pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/i, reason: "Filesystem creation / disk format (mkfs)" },
	{ pattern: /\bdd\s+if=/, reason: "Direct block disk overwrite (dd)" },
	{ pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "Fork bomb detected" },
	{ pattern: />\s*\/dev\/(?:sd[a-z]|nvme[0-9]n[0-9]|hd[a-z])\b/, reason: "Direct write to raw block device" },
];

export function isDangerousBashCommand(command: string): { dangerous: boolean; reason?: string } {
	for (const { pattern, reason } of DESTRUCTIVE_COMMAND_PATTERNS) {
		if (pattern.test(command)) return { dangerous: true, reason };
	}
	return { dangerous: false };
}

export function assertSafePath(path: string): void {
	if (isSecretPath(path)) throw new Error("Access denied: this path is protected by Noushi security policy.");
}
