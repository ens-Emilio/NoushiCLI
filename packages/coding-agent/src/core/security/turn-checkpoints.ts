// Per-turn file checkpoint journal: remembers the pre-turn content of every file built-in
// tools changed during a turn, refuses undo when anything changed outside Noushi since, and
// restores only those paths (never a whole-tree checkout).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const JOURNAL_LIMIT = 50;

export interface TurnCheckpoint {
	turnIndex: number;
	/** Paths relative to cwd, in capture order. */
	paths: string[];
	/** File content before the turn; undefined means the file did not exist. */
	preState: Map<string, string | undefined>;
	/** SHA-256 of the content Noushi last wrote this turn; undo refuses on mismatch. */
	postHashes: Map<string, string>;
}

interface JournalState {
	turns: TurnCheckpoint[];
	/** Undone turns, innermost last, so redo can report what was restored. */
	redoStack: TurnCheckpoint[];
	nextTurnIndex: number;
}

const journals = new Map<string, JournalState>();

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function readContent(cwd: string, path: string): string | undefined {
	try {
		return readFileSync(resolve(cwd, path), "utf8");
	} catch {
		return undefined;
	}
}

function normalize(cwd: string, path: string): string {
	return relative(cwd, resolve(cwd, path)).split(sep).join("/");
}

function state(cwd: string): JournalState {
	let journal = journals.get(cwd);
	if (!journal) {
		journal = { turns: [], redoStack: [], nextTurnIndex: 0 };
		journals.set(cwd, journal);
	}
	return journal;
}

/**
 * Record that a tool is about to change `path` in this turn. The first call per path per
 * turn captures the pre-turn content; later calls in the same turn keep it.
 */
export function recordTurnPath(cwd: string, path: string): void {
	const normalized = normalize(cwd, path);
	if (!normalized || normalized.startsWith("../")) return;
	const checkpoint = state(cwd).turns.at(-1);
	if (!checkpoint || checkpoint.paths.includes(normalized)) return;
	checkpoint.paths.push(normalized);
	checkpoint.preState.set(normalized, readContent(cwd, normalized));
}

/** Record the bytes Noushi wrote for `path` this turn, so undo can detect outside edits. */
export function markTurnCheckpointWritten(cwd: string, path: string): void {
	const normalized = normalize(cwd, path);
	const content = readContent(cwd, normalized);
	if (content !== undefined) state(cwd).turns.at(-1)?.postHashes.set(normalized, hashContent(content));
}

/** Open a new turn checkpoint. Called at turn start. */
export function beginTurnCheckpoint(cwd: string): void {
	const journal = state(cwd);
	journal.turns.push({ turnIndex: journal.nextTurnIndex++, paths: [], preState: new Map(), postHashes: new Map() });
	if (journal.turns.length > JOURNAL_LIMIT) journal.turns.shift();
	journal.redoStack = [];
}

/** Drop the current turn checkpoint when nothing was recorded, so empty turns stay out. */
export function sealTurnCheckpoint(cwd: string): void {
	const journal = journals.get(cwd);
	const checkpoint = journal?.turns.at(-1);
	if (checkpoint && checkpoint.paths.length === 0) journal!.turns.pop();
}

/** The latest turn checkpoint with recorded paths, for the undo command. */
export function latestTurnCheckpoint(cwd: string): TurnCheckpoint | undefined {
	const turns = journals.get(cwd)?.turns ?? [];
	return turns.findLast((checkpoint) => checkpoint.paths.length > 0);
}

export interface TurnRestoreResult {
	success: boolean;
	message: string;
}

function conflictingPaths(cwd: string, checkpoint: TurnCheckpoint): string[] {
	return checkpoint.paths.filter((path) => {
		const expected = checkpoint.postHashes.get(path);
		if (expected === undefined) return existsSync(resolve(cwd, path));
		const content = readContent(cwd, path);
		return content === undefined || hashContent(content) !== expected;
	});
}

/**
 * Undo the latest recorded turn: restore pre-turn content, but only when every file still
 * matches what Noushi last wrote. Restored paths move to the redo stack.
 */
export function undoTurnCheckpoint(cwd: string): TurnRestoreResult {
	const journal = journals.get(cwd);
	const checkpoint = latestTurnCheckpoint(cwd);
	if (!journal || !checkpoint) {
		return { success: false, message: "No Noushi turn checkpoint is available to undo." };
	}
	const conflicts = conflictingPaths(cwd, checkpoint);
	if (conflicts.length > 0) {
		return {
			success: false,
			message: `Files changed outside Noushi since the last turn; undo refused: ${conflicts.join(", ")}`,
		};
	}
	try {
		for (const path of checkpoint.paths) {
			const content = checkpoint.preState.get(path);
			const absolute = resolve(cwd, path);
			if (content === undefined) {
				if (existsSync(absolute)) rmSync(absolute);
				continue;
			}
			mkdirSync(dirname(absolute), { recursive: true });
			writeFileSync(absolute, content);
		}
	} catch {
		return { success: false, message: "Undo failed; the checkpoint was kept." };
	}
	journal.turns = journal.turns.filter((turn) => turn !== checkpoint);
	journal.redoStack.push(checkpoint);
	return { success: true, message: `Undid turn: restored ${checkpoint.paths.length} path(s).` };
}

/** The most recent undone turn, for the redo command. */
export function lastUndoneTurn(cwd: string): TurnCheckpoint | undefined {
	return journals.get(cwd)?.redoStack.at(-1);
}
