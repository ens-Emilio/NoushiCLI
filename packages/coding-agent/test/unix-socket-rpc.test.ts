import { lstat, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listenRpcSocket, listenRpcSocketBridge } from "../src/core/unix-socket-rpc.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "noushi-rpc-"));
	directories.push(directory);
	return directory;
}

function request(path: string, value: unknown): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	const socket = connect(path);
	let response = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk) => {
		response += chunk;
		if (response.includes("\n")) {
			socket.end();
			resolve(JSON.parse(response.slice(0, response.indexOf("\n"))));
		}
	});
	socket.on("error", reject);
	socket.on("connect", () => socket.write(`${JSON.stringify(value)}\n`));
	return promise;
}

describe("Unix socket RPC transport", () => {
	it("handles JSONL requests with a private socket and removes it on close", async () => {
		const path = join(await temporaryDirectory(), "rpc.sock");
		const rpc = await listenRpcSocket(path, (value) => ({ echoed: value }));
		const socketStats = await stat(path);
		expect(socketStats.mode & 0o777).toBe(0o600);
		expect(await request(path, { type: "status" })).toEqual({ echoed: { type: "status" } });
		await rpc.close();
		await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("bridges the complete RPC stream to a fixed child command", async () => {
		const path = join(await temporaryDirectory(), "rpc-bridge.sock");
		const script = "process.stdin.pipe(process.stdout)";
		const rpc = await listenRpcSocketBridge(path, process.execPath, ["-e", script]);
		const socket = connect(path);
		let response = "";
		socket.setEncoding("utf8");

		const { promise: connected, resolve: resolveConnected, reject: rejectConnected } = Promise.withResolvers<void>();
		const { promise: ended, resolve: resolveEnded } = Promise.withResolvers<void>();
		socket.on("data", (chunk) => {
			response += chunk;
		});
		socket.once("end", resolveEnded);
		socket.once("error", rejectConnected);
		socket.once("connect", resolveConnected);
		await connected;
		socket.write('{"id":"one","type":"get_state"}\n{"type":"extension_ui_response","id":"ui","value":"é"}\n');
		socket.end();
		await ended;
		expect(response).toBe(
			'{"id":"one","type":"get_state"}\n{"type":"extension_ui_response","id":"ui","value":"é"}\n',
		);
		await rpc.close();
	});

	it("refuses to replace an existing filesystem path", async () => {
		const path = join(await temporaryDirectory(), "existing");
		await writeFile(path, "keep");
		await expect(listenRpcSocket(path, () => null)).rejects.toThrow("Refusing to replace existing RPC socket path");
	});
});
