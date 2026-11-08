// Chrome DevTools Protocol browser service for `/xomp-browser`: resolves a Chromium
// binary explicitly, launches it with an isolated profile, and drives pages over the
// CDP WebSocket endpoint in flat session mode. The service only ever connects to a
// browser process it launched itself; attaching to an already-running browser is
// refused by design.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "undici";

export interface BrowserBinary {
	path: string;
	source: string;
}

export interface BrowserStatus {
	available: boolean;
	binary: BrowserBinary | undefined;
	running: boolean;
}

const CDP_CONNECT_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 30_000;
/** Candidate Chromium-family binaries in resolution order; CHROMIUM_BIN is read at
 * call time so tests and wrappers can inject a binary per invocation. */
function binaryCandidates(): Array<{ path: string; source: string }> {
	return [
		{ path: process.env.CHROMIUM_BIN ?? "", source: "CHROMIUM_BIN" },
		{ path: "/usr/bin/google-chrome-stable", source: "system" },
		{ path: "/usr/bin/chromium", source: "system" },
		{ path: "/usr/bin/chromium-browser", source: "system" },
		{ path: "/snap/bin/chromium", source: "system" },
		{ path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", source: "system" },
	];
}

/** Resolve the browser binary: CHROMIUM_BIN first, then well-known system paths. */
export function resolveBrowserBinary(): BrowserBinary | undefined {
	for (const candidate of binaryCandidates()) {
		if (candidate.path && existsSync(candidate.path)) return { path: candidate.path, source: candidate.source };
	}
	return undefined;
}

interface CdpMessage {
	id?: number;
	method?: string;
	sessionId?: string;
	error?: { message: string };
	result?: unknown;
}

/**
 * Browser-level CDP client. Commands carry an explicit sessionId (flat session mode);
 * replies are matched by id, and a single in-flight command per session is assumed.
 */
class CdpConnection {
	private ws: WebSocket | undefined;
	private nextId = 1;
	private readonly pending = new Map<number, PromiseWithResolvers<unknown>>();

	async connect(wsUrl: string): Promise<void> {
		const { promise: opened, resolve, reject } = Promise.withResolvers<void>();
		this.ws = new WebSocket(wsUrl);
		this.ws.addEventListener("open", () => resolve());
		this.ws.addEventListener("error", () => reject(new Error(`CDP WebSocket connection failed: ${wsUrl}`)));
		await Promise.race([
			opened,
			sleep(CDP_CONNECT_TIMEOUT_MS).then(() => {
				throw new Error(`Timed out connecting to the browser CDP endpoint after ${CDP_CONNECT_TIMEOUT_MS}ms.`);
			}),
		]);
		this.ws.addEventListener("message", (event) => {
			const data = JSON.parse(String(event.data)) as CdpMessage;
			if (data.id === undefined) return;
			const entry = this.pending.get(data.id);
			if (!entry) return;
			this.pending.delete(data.id);
			if (data.error) entry.reject(new Error(data.error.message));
			else entry.resolve(data.result);
		});
	}

	async send(sessionId: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		if (!this.ws) throw new Error("The CDP connection is not open.");
		const id = this.nextId++;
		const entry = Promise.withResolvers<unknown>();
		this.pending.set(id, entry);
		this.ws.send(JSON.stringify({ id, sessionId, method, params }));
		return Promise.race([
			entry.promise,
			sleep(COMMAND_TIMEOUT_MS).then(() => {
				this.pending.delete(id);
				throw new Error(`CDP command ${method} timed out after ${COMMAND_TIMEOUT_MS}ms.`);
			}),
		]);
	}

	close(): void {
		this.ws?.close();
		this.ws = undefined;
	}
}

export class BrowserService {
	private process: ChildProcess | undefined;
	private connection: CdpConnection | undefined;
	private profileDir: string | undefined;
	private readonly binary: BrowserBinary | undefined;
	private readonly headless: boolean;

	/**
	 * `binary` accepts an explicit injection (tests, wrappers); `null` forces
	 * unavailability; omitted resolves from the environment at construction time.
	 */
	constructor(options: { binary?: BrowserBinary | null; headless?: boolean } = {}) {
		this.binary = options.binary === null ? undefined : (options.binary ?? resolveBrowserBinary());
		this.headless = options.headless ?? true;
	}

	/** Availability without side effects: is a binary resolvable, is the browser running. */
	status(): BrowserStatus {
		return { available: this.binary !== undefined, binary: this.binary, running: this.process !== undefined };
	}

	/** Launch the browser (if needed) and open `url` in a fresh page. Returns the target id. */
	async open(url: string): Promise<string> {
		if (!this.binary)
			throw new Error("No Chromium-family browser binary found. Set CHROMIUM_BIN or install chromium.");
		if (!this.process) await this.launch();
		const target = (await this.browserCommand("Target.createTarget", { url })) as { targetId: string };
		return target.targetId;
	}

	private browserCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		if (!this.connection) throw new Error("No browser page is open; call open() first.");
		return this.connection.send("", method, params);
	}

	private async launch(): Promise<void> {
		this.profileDir = mkdtempSync(join(tmpdir(), "noushi-browser-"));
		this.process = spawn(
			this.binary!.path,
			[
				"--remote-debugging-port=0",
				`--user-data-dir=${this.profileDir}`,
				...(this.headless ? ["--headless=new"] : []),
				"--no-first-run",
				"--no-default-browser-check",
				"about:blank",
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		this.process.on("exit", () => {
			this.process = undefined;
		});
		const wsUrl = await this.readDevToolsUrl();
		this.connection = new CdpConnection();
		await this.connection.connect(wsUrl);
	}

	/** Read the DevTools WebSocket URL; with --remote-debugging-port=0 Chromium prints it on stderr. */
	private async readDevToolsUrl(): Promise<string> {
		const chunks: string[] = [];
		this.process!.stderr!.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
		const deadline = Date.now() + CDP_CONNECT_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const match = chunks.join("").match(/ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]+/u);
			if (match) return match[0];
			if (this.process === undefined)
				throw new Error("The browser process exited before publishing its DevTools endpoint.");
			await sleep(100);
		}
		throw new Error(`Timed out reading the browser DevTools endpoint after ${CDP_CONNECT_TIMEOUT_MS}ms.`);
	}

	/** Attach to a page target and run a session-scoped command. */
	private async pageCommand(targetId: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		if (!this.connection) throw new Error("No browser page is open; call open() first.");
		const attach = (await this.browserCommand("Target.attachToTarget", { targetId, flatten: true })) as {
			sessionId: string;
		};
		return this.connection.send(attach.sessionId, method, params);
	}

	/** Navigate a page and report the outcome. */
	navigate(targetId: string, url: string): Promise<unknown> {
		return this.pageCommand(targetId, "Page.navigate", { url });
	}

	/** Evaluate an expression in the page's main world. */
	async evaluate(targetId: string, expression: string): Promise<unknown> {
		const result = (await this.pageCommand(targetId, "Runtime.evaluate", { expression, returnByValue: true })) as {
			result?: { value?: unknown };
			exceptionDetails?: { text: string };
		};
		if (result.exceptionDetails) throw new Error(`Page evaluation failed: ${result.exceptionDetails.text}`);
		return result.result?.value;
	}

	/** Capture a screenshot as base64 PNG. */
	async screenshot(targetId: string): Promise<string> {
		const result = (await this.pageCommand(targetId, "Page.captureScreenshot", { format: "png" })) as {
			data: string;
		};
		return result.data;
	}

	/** Kill the browser process and remove the profile directory. */
	async close(): Promise<void> {
		this.connection?.close();
		this.connection = undefined;
		this.process?.kill();
		this.process = undefined;
		if (this.profileDir) {
			rmSync(this.profileDir, { recursive: true, force: true });
			this.profileDir = undefined;
		}
	}
}
