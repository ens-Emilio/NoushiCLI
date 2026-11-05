import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	captureGitCheckpointPath,
	getGitCheckpointPaths,
	markGitCheckpointPathWritten,
	rollbackGitCheckpoint,
} from "../src/core/security/checkpoint.ts";
import {
	assertSafePath,
	isDangerousBashCommand,
	isSecretPath,
	isSecretReadCommand,
} from "../src/core/security/policy.ts";

const dirs: string[] = [];

function makeRepo(): string {
	const cwd = mkdtempSync(join(tmpdir(), "noushi-security-"));
	dirs.push(cwd);
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync(
		"git",
		["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"],
		{ cwd },
	);
	return cwd;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("security policy", () => {
	test("blocks credential filenames without matching unrelated paths", () => {
		expect(isSecretPath(".env.local")).toBe(true);
		expect(isSecretPath("/home/user/.ssh/id_ed25519")).toBe(true);
		expect(isSecretPath("src/config.ts")).toBe(false);
		expect(isSecretPath("src/env.local.ts")).toBe(false);
	});
	test("detects secret paths in explicit shell reads, including quoted and absolute arguments", () => {
		for (const command of [
			"cat .env",
			"head -n 5 '/workspace/.env.local'",
			'tail "/home/user/.ssh/id_ed25519"',
			"sed -n '1,4p' /workspace/credentials.json",
			"awk '{print $1}' ./client.pem",
			"less /workspace/private.key",
			"more /workspace/backup.p12",
			"grep token /workspace/.env",
			"rg token /workspace/.env.production",
			"echo safe; cat '/workspace/.env'",
		])
			expect(isSecretReadCommand(command)).toBe(true);
	});

	test("allows unrelated shell work and denies uncertain explicit reads", () => {
		for (const command of [
			"echo .env",
			"cat README.md",
			"npm test",
			"grep token src/config.ts",
			"cat README.md; ls file*.txt",
		]) {
			expect(isSecretReadCommand(command)).toBe(false);
		}
		expect(isSecretReadCommand('cat "$SECRET_FILE"')).toBe(true);
		expect(isSecretReadCommand("cat file*.txt")).toBe(true);
	});
	test("rejects secret paths used as search roots", () => {
		expect(() => assertSafePath("/workspace/.env")).toThrow(/protected/i);
		expect(() => assertSafePath("/workspace/src/config.ts")).not.toThrow();
	});

	test("identifies dangerous commands", () => {
		expect(isDangerousBashCommand("rm -rf build").dangerous).toBe(true);
		expect(isDangerousBashCommand("git reset --hard HEAD").dangerous).toBe(true);
		expect(isDangerousBashCommand("npm test").dangerous).toBe(false);
	});

	test("rollback requires captured paths and preserves unselected paths", () => {
		const cwd = makeRepo();
		expect(rollbackGitCheckpoint(cwd, ["a.txt"]).success).toBe(false);
		writeFileSync(join(cwd, "a.txt"), "committed a");
		writeFileSync(join(cwd, "b.txt"), "committed b");
		execFileSync("git", ["add", "a.txt", "b.txt"], { cwd });
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "files"], {
			cwd,
		});
		writeFileSync(join(cwd, "a.txt"), "before turn a");
		writeFileSync(join(cwd, "b.txt"), "before turn b");
		expect(captureGitCheckpointPath(cwd, "a.txt").created).toBe(true);
		writeFileSync(join(cwd, "a.txt"), "agent result");
		markGitCheckpointPathWritten(cwd, "a.txt");
		expect(getGitCheckpointPaths(cwd)).toEqual(["a.txt"]);
		writeFileSync(join(cwd, "b.txt"), "unrelated update");
		expect(rollbackGitCheckpoint(cwd, ["a.txt", "b.txt", "untracked.txt"]).success).toBe(true);
		expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("before turn a");

		expect(readFileSync(join(cwd, "b.txt"), "utf8")).toBe("unrelated update");
	});

	test("rollback refuses paths changed after Noushi wrote them", () => {
		const cwd = makeRepo();
		writeFileSync(join(cwd, "file.txt"), "committed");
		execFileSync("git", ["add", "file.txt"], { cwd });
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "file"], {
			cwd,
		});
		writeFileSync(join(cwd, "file.txt"), "before turn");
		captureGitCheckpointPath(cwd, "file.txt");
		writeFileSync(join(cwd, "file.txt"), "Noushi result");
		markGitCheckpointPathWritten(cwd, "file.txt");
		writeFileSync(join(cwd, "file.txt"), "later user edit");
		expect(rollbackGitCheckpoint(cwd, ["file.txt"]).success).toBe(false);
		expect(readFileSync(join(cwd, "file.txt"), "utf8")).toBe("later user edit");
	});
});
