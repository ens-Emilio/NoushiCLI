import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { markTurnCheckpointWritten, recordTurnPath } from "./turn-checkpoints.ts";

export interface CheckpointResult {
	created: boolean;
	ref?: string;
	message: string;
}

interface Checkpoint {
	ref: string;
	paths: Map<string, string | undefined>;
}
const checkpoints = new Map<string, Checkpoint>();

function normalizeTrackedPath(cwd: string, path: string): string | undefined {
	const absolutePath = resolve(cwd, path);
	const normalized = relative(cwd, absolutePath).split(sep).join("/");
	if (!normalized || normalized === ".." || normalized.startsWith("../")) return undefined;
	try {
		execFileSync("git", ["ls-files", "--error-unmatch", "--", normalized], { cwd, stdio: "ignore" });
		return normalized;
	} catch {
		return undefined;
	}
}

/** Capture the pre-mutation tree before a built-in tool changes a tracked path. */
export function captureGitCheckpointPath(cwd: string, path: string): CheckpointResult {
	const normalized = normalizeTrackedPath(cwd, path);
	recordTurnPath(cwd, normalized ?? path);
	if (!normalized)
		return { created: false, message: "Only tracked paths inside the working directory can be checkpointed." };
	try {
		let checkpoint = checkpoints.get(cwd);
		if (!checkpoint) {
			const createdRef = execFileSync("git", ["stash", "create", "noushi-auto-checkpoint"], {
				cwd,
				encoding: "utf8",
			}).trim();
			const ref = createdRef || execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
			if (!/^[0-9a-f]{40,64}$/i.test(ref)) return { created: false, message: "Git could not create a checkpoint." };
			checkpoint = { ref, paths: new Map() };
			checkpoints.set(cwd, checkpoint);
		}
		if (!checkpoint.paths.has(normalized)) checkpoint.paths.set(normalized, undefined);
		return { created: true, ref: checkpoint.ref, message: `Git checkpoint active: ${checkpoint.ref.slice(0, 8)}` };
	} catch {
		return { created: false, message: "Not a git repository or git command unavailable." };
	}
}

/** Record the bytes written by Noushi so rollback can refuse intervening user edits. */
export function markGitCheckpointPathWritten(cwd: string, path: string): void {
	const normalized = normalizeTrackedPath(cwd, path);
	markTurnCheckpointWritten(cwd, normalized ?? path);
	const checkpoint = checkpoints.get(cwd);
	if (!normalized || !checkpoint?.paths.has(normalized)) return;
	try {
		checkpoint.paths.set(
			normalized,
			createHash("sha256")
				.update(readFileSync(resolve(cwd, normalized)))
				.digest("hex"),
		);
	} catch {
		checkpoint.paths.set(normalized, undefined);
	}
}

/** List paths explicitly captured before a tool mutation. */
export function getGitCheckpointPaths(cwd: string): string[] {
	return [...(checkpoints.get(cwd)?.paths ?? [])].filter(([, hash]) => hash !== undefined).map(([path]) => path);
}

/** Legacy explicit checkpoint of existing tracked changes; it does not enable implicit rollback. */
export function createGitCheckpoint(cwd: string): CheckpointResult {
	try {
		const changed = execFileSync("git", ["diff", "--name-only", "-z", "HEAD"], { cwd, encoding: "utf8" })
			.split("\0")
			.filter(Boolean);
		if (!changed.length) return { created: false, message: "No tracked changes to checkpoint." };
		const ref = execFileSync("git", ["stash", "create", "noushi-auto-checkpoint"], { cwd, encoding: "utf8" }).trim();
		if (!/^[0-9a-f]{40,64}$/i.test(ref)) return { created: false, message: "Git could not create a checkpoint." };
		checkpoints.set(cwd, { ref, paths: new Map() });
		return { created: true, ref, message: `Git checkpoint created: ${ref.slice(0, 8)}` };
	} catch {
		return { created: false, message: "Not a git repository or git command unavailable." };
	}
}

/** Restore only explicitly captured paths. */
export function rollbackGitCheckpoint(cwd: string, changedPaths: string[]): { success: boolean; message: string } {
	const checkpoint = checkpoints.get(cwd);
	if (!checkpoint) return { success: false, message: "No valid Noushi checkpoint is available to roll back." };
	const paths = [...new Set(changedPaths)].filter((path) => checkpoint.paths.has(path));
	if (!paths.length)
		return { success: false, message: "No checkpointed paths from this Noushi turn are available to roll back." };
	const safePaths = paths.filter((path) => {
		const expected = checkpoint.paths.get(path);
		if (expected === undefined) return false;
		try {
			const current = createHash("sha256")
				.update(readFileSync(resolve(cwd, path)))
				.digest("hex");
			return current === expected;
		} catch {
			return false;
		}
	});
	if (!safePaths.length)
		return { success: false, message: "Checkpointed paths changed since Noushi last wrote them; rollback refused." };
	try {
		execFileSync("git", ["checkout", checkpoint.ref, "--", ...safePaths], { cwd, stdio: "ignore" });
		for (const path of safePaths) checkpoint.paths.delete(path);
		if (!checkpoint.paths.size) checkpoints.delete(cwd);
		return { success: true, message: `Rolled back ${safePaths.length} checkpointed path(s).` };
	} catch {
		return { success: false, message: "Rollback failed; checkpoint was retained." };
	}
}
