// Behavioral tests for the SSH execution contract: policy (allowlist/denylist), fixed
// flag construction, consent refusal, output caps, timeouts, and exit-code fidelity —
// all against a fake ssh binary so no network or real ssh is needed.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSshArgs, checkCommandPolicy, runSshCommand, SshCommandRejected } from "../src/core/ssh-executor.ts";
import type { SshHost } from "../src/core/ssh-hosts.ts";

function makeHost(overrides: Partial<SshHost> = {}): SshHost {
	return {
		alias: "test",
		hostname: "test.example.com",
		user: "deploy",
		port: 22,
		identityFile: undefined,
		...overrides,
	};
}

describe("command policy", () => {
	it("rejects commands outside the allowlist before any process starts", () => {
		const host = makeHost({ allowedCommands: ["systemctl status"] });
		expect(() => checkCommandPolicy(host, "rm -rf /")).toThrow(SshCommandRejected);
		expect(() => checkCommandPolicy(host, "systemctl status nginx")).not.toThrow();
	});

	it("denylist wins over allowlist", () => {
		const host = makeHost({ allowedCommands: ["reboot"], forbiddenCommands: ["reboot"] });
		expect(() => checkCommandPolicy(host, "reboot")).toThrow(SshCommandRejected);
	});

	it("consent-only hosts (no lists) accept any command for the caller to confirm", () => {
		expect(() => checkCommandPolicy(makeHost(), "anything")).not.toThrow();
	});
});

describe("argv construction", () => {
	it("places the command last and never lets it become a flag", () => {
		const args = buildSshArgs(makeHost({ port: 2222, identityFile: "~/.ssh/key" }), "ls -la", 30_000);
		expect(args).toEqual([
			"-p",
			"2222",
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=30",
			"-i",
			"~/.ssh/key",
			"deploy@test.example.com",
			"--",
			"ls -la",
		]);
	});
});

describe("runSshCommand with a fake binary", () => {
	let dir: string;
	let callsFile: string;
	let fakeSsh: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ssh-run-"));
		callsFile = join(dir, "calls.log");
		fakeSsh = join(dir, "fake-ssh");
		// The fake records its argv and behaves per the NOUSHI_FAKE_SSH env var.
		writeFileSync(
			fakeSsh,
			`#!/bin/sh
echo "$@" >> ${JSON.stringify(callsFile)}
case "$NOUSHI_FAKE_SSH" in
	success) echo "hello remote"; exit 0;;
	fail) echo "boom" >&2; exit 3;;
	cap) yes | head -c 999999999 ;;
	timeout) sleep 30 ;;
esac
`,
		);
		chmodSync(fakeSsh, 0o755);
	});

	afterEach(() => {
		delete process.env.NOUSHI_FAKE_SSH;
		rmSync(dir, { recursive: true, force: true });
	});

	it("reports exit code and stdout on success", async () => {
		process.env.NOUSHI_FAKE_SSH = "success";
		const result = await runSshCommand(makeHost(), "uptime", { sshBinary: fakeSsh });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("hello remote");
		expect(result.truncated).toBe(false);
	});

	it("preserves a non-zero exit as a structured result", async () => {
		process.env.NOUSHI_FAKE_SSH = "fail";
		const result = await runSshCommand(makeHost(), "boom", { sshBinary: fakeSsh });
		expect(result.exitCode).toBe(3);
		expect(result.stderr).toContain("boom");
	});

	it("truncates output at the cap instead of buffering forever", async () => {
		process.env.NOUSHI_FAKE_SSH = "cap";
		const result = await runSshCommand(makeHost(), "spam", { sshBinary: fakeSsh, outputCapBytes: 4096 });
		expect(result.exitCode).toBe("output-cap");
		expect(result.truncated).toBe(true);
	});

	it("kills the process on timeout and reports it", async () => {
		process.env.NOUSHI_FAKE_SSH = "timeout";
		const result = await runSshCommand(makeHost(), "hang", { sshBinary: fakeSsh, timeoutMs: 500 });
		expect(result.exitCode).toBe("timeout");
		expect(result.durationMs).toBeLessThan(5_000);
	});

	it("the command text appears only in the trailing position of the spawned argv", () => {
		const args = buildSshArgs(makeHost(), "echo hi", 30_000);
		expect(args.at(-1)).toBe("echo hi");
		expect(args.slice(0, -2).every((arg) => !arg.includes("hi"))).toBe(true);
	});
});
