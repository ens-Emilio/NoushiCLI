import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getChangedTrackedFiles, runChangedFileValidation } from "../src/core/changed-file-validation.ts";
import { verifyExtensionDigest } from "../src/core/extensions/integrity.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "noushi-wave6-"));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("extension SHA-256 verification", () => {
	it("accepts matching package-relative digests and rejects changed content", async () => {
		const root = tempDir();
		const file = join(root, "extensions", "entry.js");
		mkdirSync(join(root, "extensions"));
		writeFileSync(file, "export default () => {};\n");
		const digest = createHash("sha256").update("export default () => {};\n").digest("hex");
		expect(await verifyExtensionDigest(root, file, { "extensions/entry.js": digest })).toMatchObject({
			verified: true,
		});
		writeFileSync(file, "changed");
		expect(await verifyExtensionDigest(root, file, { "extensions/entry.js": digest })).toMatchObject({
			verified: false,
		});
	});

	it("rejects paths outside the package root", async () => {
		const root = tempDir();
		await expect(verifyExtensionDigest(root, join(root, "..", "outside.js"), {})).rejects.toThrow(
			"inside the package root",
		);
	});
	it("checks declared digests before importing package extensions", async () => {
		const root = tempDir();
		const extensionPath = join(root, "extensions", "entry.js");
		const source = "export default () => {};";
		mkdirSync(join(root, "extensions"));
		writeFileSync(extensionPath, source);
		const digest = createHash("sha256").update(source).digest("hex");
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ pi: { integrity: { "extensions/entry.js": digest } } }),
		);
		expect((await loadExtensions([extensionPath], root)).errors).toEqual([]);
		writeFileSync(extensionPath, `${source}\\n// tampered`);
		expect((await loadExtensions([extensionPath], root)).errors[0]?.error).toContain("SHA-256 mismatch");
	}, 15000);
});

describe("changed tracked file validation", () => {
	it("passes changed tracked paths to configured commands without shell expansion", async () => {
		const cwd = tempDir();
		const git = (args: string[]) => {
			const result = spawnSync("git", args, { cwd, encoding: "utf8" });
			if (result.status !== 0) throw new Error(result.stderr);
		};
		git(["init", "-q"]);
		git(["config", "user.email", "test@example.invalid"]);
		git(["config", "user.name", "Test"]);
		writeFileSync(join(cwd, "tracked file.ts"), "before\n");
		git(["add", "--", "tracked file.ts"]);
		git(["commit", "-qm", "initial"]);
		writeFileSync(join(cwd, "tracked file.ts"), "after\n");
		writeFileSync(join(cwd, "untracked.ts"), "ignored\n");
		expect(await getChangedTrackedFiles(cwd)).toEqual(["tracked file.ts"]);
		const result = await runChangedFileValidation(cwd, [
			{ command: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))"] },
		]);
		expect(result.commands[0]?.code).toBe(0);
		expect(JSON.parse(result.commands[0]!.stdout)).toEqual(["tracked file.ts"]);
	});

	it("honors cancellation between configured commands", async () => {
		const cwd = tempDir();
		const controller = new AbortController();
		controller.abort();
		const result = await runChangedFileValidation(cwd, [{ command: process.execPath }], {
			signal: controller.signal,
		});
		expect(result.commands).toEqual([]);
	});
});
