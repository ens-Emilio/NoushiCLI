import { execCommand } from "./exec.ts";

export interface ValidationCommand {
	command: string;
	args?: string[];
	timeoutMs?: number;
}

export interface ValidationResult {
	files: string[];
	commands: Array<{
		command: string;
		args: string[];
		code: number;
		stdout: string;
		stderr: string;
		timedOut: boolean;
		cancelled: boolean;
	}>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 15 * 60_000;

/** List tracked paths changed relative to HEAD, including staged, unstaged, and deleted files. */
export async function getChangedTrackedFiles(cwd: string, signal?: AbortSignal): Promise<string[]> {
	const result = await execCommand(
		"git",
		["diff", "--name-only", "--diff-filter=ACDMRTUXB", "-z", "HEAD", "--"],
		cwd,
		{
			timeout: DEFAULT_TIMEOUT_MS,
			signal,
			maxBuffer: 4 * 1024 * 1024,
		},
	);
	if (result.killed || result.code !== 0)
		throw new Error(result.stderr || "Unable to read changed tracked files from git");
	return [...new Set(result.stdout.split("\0").filter(Boolean))].sort();
}

/** Run configured commands once per changed path; no command is inferred and no files are modified automatically. */
export async function runChangedFileValidation(
	cwd: string,
	commands: ValidationCommand[],
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ValidationResult> {
	if (options.signal?.aborted) return { files: [], commands: [] };
	const files = await getChangedTrackedFiles(cwd, options.signal);
	const results: ValidationResult["commands"] = [];
	for (const configured of commands) {
		if (options.signal?.aborted) break;
		const args = [...(configured.args ?? []), ...files];
		const timeoutMs = configured.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
			throw new RangeError(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
		}
		const result = await execCommand(configured.command, args, cwd, {
			timeout: timeoutMs,
			signal: options.signal,
			maxBuffer: 4 * 1024 * 1024,
		});
		results.push({
			command: configured.command,
			args,
			code: result.code,
			stdout: result.stdout,
			stderr: result.stderr,
			timedOut: result.killed && !options.signal?.aborted,
			cancelled: options.signal?.aborted === true,
		});
	}
	return { files, commands: results };
}
