import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	beginTurnCheckpoint,
	lastUndoneTurn,
	latestTurnCheckpoint,
	markTurnCheckpointWritten,
	recordTurnPath,
	undoTurnCheckpoint,
} from "../../src/core/security/turn-checkpoints.ts";

describe("per-turn checkpoint journal", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "noushi-turn-checkpoints-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	function runTurn(index: number): void {
		beginTurnCheckpoint(cwd);
		recordTurnPath(cwd, join(cwd, "file.txt"));
		writeFileSync(join(cwd, "file.txt"), `turn ${index} content`);
		markTurnCheckpointWritten(cwd, join(cwd, "file.txt"));
	}

	it("undoes the last turn's writes and detects concurrent outside edits", () => {
		writeFileSync(join(cwd, "file.txt"), "before");
		runTurn(1);
		expect(readFileSync(join(cwd, "file.txt"), "utf8")).toBe("turn 1 content");

		const undo = undoTurnCheckpoint(cwd);
		expect(undo.success).toBe(true);
		expect(readFileSync(join(cwd, "file.txt"), "utf8")).toBe("before");
		expect(lastUndoneTurn(cwd)?.paths).toEqual(["file.txt"]);

		// Another Noushi turn: pre-state is now the restored content.
		runTurn(2);
		expect(readFileSync(join(cwd, "file.txt"), "utf8")).toBe("turn 2 content");

		// Outside edit after Noushi wrote: undo must refuse.
		writeFileSync(join(cwd, "file.txt"), "hand edited by user");
		const refused = undoTurnCheckpoint(cwd);
		expect(refused.success).toBe(false);
		expect(refused.message).toContain("changed outside Noushi");
		expect(refused.message).toContain("file.txt");
		expect(readFileSync(join(cwd, "file.txt"), "utf8")).toBe("hand edited by user");
	});

	it("restores a file a turn deleted, and prunes sealed empty turns", () => {
		writeFileSync(join(cwd, "gone.txt"), "earlier");
		beginTurnCheckpoint(cwd);
		recordTurnPath(cwd, join(cwd, "gone.txt"));
		rmSync(join(cwd, "gone.txt"));

		const undo = undoTurnCheckpoint(cwd);
		expect(undo.success).toBe(true);
		expect(readFileSync(join(cwd, "gone.txt"), "utf8")).toBe("earlier");
		expect(lastUndoneTurn(cwd)?.paths).toEqual(["gone.txt"]);
	});

	it("keeps only the newest turn undoable and prunes the journal", () => {
		writeFileSync(join(cwd, "file.txt"), "base");
		for (let index = 0; index < 60; index++) runTurn(index);
		const undo = undoTurnCheckpoint(cwd);
		expect(undo.success).toBe(true);
		expect(readFileSync(join(cwd, "file.txt"), "utf8")).toBe("turn 58 content");
	});

	it("leaves empty turns without checkpoints and reports no checkpoint when nothing changed", () => {
		beginTurnCheckpoint(cwd);
		expect(latestTurnCheckpoint(cwd)).toBeUndefined();
		const undo = undoTurnCheckpoint(cwd);
		expect(undo.success).toBe(false);
		expect(undo.message).toContain("No Noushi turn checkpoint");
	});
});
