// SSH remote command executor for `/xomp-ssh run`, implementing the contract in
// docs/ssh-execution-contract.md: per-command consent is handled by the caller; this
// module enforces the allowlist/denylist, fixed flag construction, output caps,
// consent having passed through ui.confirm.

import { spawn } from "node:child_process";
import type { SshHost } from "./ssh-hosts.ts";

export interface SshRunResult {
	exitCode: number | "timeout" | "output-cap";
	stdout: string;
	stderr: string;
	truncated: boolean;
	durationMs: number;
}

export interface SshRunOptions {
	/** Binary to run; defaults to the system ssh. Tests inject a fake here. */
	sshBinary?: string;
	timeoutMs?: number;
	/** Combined stdout+stderr cap in bytes. */
	outputCapBytes?: number;
}

export const DEFAULT_SSH_TIMEOUT_MS = 30_000;
export const MAX_SSH_TIMEOUT_MS = 300_000;
export const DEFAULT_OUTPUT_CAP_BYTES = 256 * 1024;

export class SshCommandRejected extends Error {}

/** Check a command against the host's allowlist/denylist; denylist always wins. */
export function checkCommandPolicy(host: SshHost, command: string): void {
	if (host.forbiddenCommands?.some((prefix) => command === prefix || command.startsWith(`${prefix} `))) {
		throw new SshCommandRejected(`Command is on the denylist for host "${host.alias}".`);
	}
	if (
		host.allowedCommands &&
		!host.allowedCommands.some((prefix) => command === prefix || command.startsWith(`${prefix} `))
	) {
		throw new SshCommandRejected(`Command is not on the allowlist for host "${host.alias}".`);
	}
}

/** Build the fixed ssh argv; the command only ever appears in the final position. */
export function buildSshArgs(host: SshHost, command: string, timeoutMs: number): string[] {
	const args: string[] = [
		"-p",
		String(host.port),
		"-o",
		"BatchMode=yes",
		"-o",
		`ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
	];
	if (host.identityFile) args.push("-i", host.identityFile);
	const destination = host.user ? `${host.user}@${host.hostname}` : host.hostname;
	args.push(destination, "--", command);
	return args;
}

/** Run `command` on the host under the execution contract. Consent is the caller's duty. */
export function runSshCommand(host: SshHost, command: string, options: SshRunOptions = {}): Promise<SshRunResult> {
	checkCommandPolicy(host, command);
	const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS, 1), MAX_SSH_TIMEOUT_MS);
	const cap = options.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES;
	const binary = options.sshBinary ?? "ssh";
	const args = buildSshArgs(host, command, timeoutMs);
	return new Promise((resolve) => {
		const started = Date.now();
		const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
		let stdout = "";
		let stderr = "";
		let truncated = false;
		let settled = false;
		let timedOut = false;
		const finish = (exitCode: SshRunResult["exitCode"]) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ exitCode, stdout, stderr, truncated, durationMs: Date.now() - started });
		};
		// The command may have spawned grandchildren that hold the output pipes;
		// kill the whole process group so close fires promptly.
		const killGroup = () => {
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup();
		}, timeoutMs);
		const append = (current: string, chunk: Buffer) => {
			if (truncated) return current;
			if (Buffer.byteLength(current, "utf8") + chunk.length > cap) {
				truncated = true;
				killGroup();
				return current;
			}
			return current + chunk.toString("utf8");
		};
		child.stdout!.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk);
		});
		child.stderr!.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk);
		});
		child.on("error", (error) => {
			stderr = `${stderr}${truncated ? "\n" : ""}${error.message}`;
			finish(127);
		});
		child.on("close", (code) => {
			if (truncated) finish("output-cap");
			else if (timedOut) finish("timeout");
			else finish(code ?? 127);
		});
	});
}
