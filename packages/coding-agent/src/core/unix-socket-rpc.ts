import { type ChildProcess, spawn } from "node:child_process";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { resolve } from "node:path";

const MAX_REQUEST_BYTES = 1024 * 1024;

export type RpcSocketHandler = (request: unknown) => unknown | Promise<unknown>;

/** Bind a private JSONL RPC socket. Each connection carries one request and response. */
export async function listenRpcSocket(
	path: string,
	handler: RpcSocketHandler,
): Promise<{ path: string; close(): Promise<void> }> {
	if (process.platform === "win32") throw new Error("Unix domain sockets are unavailable on Windows");
	const socketPath = resolve(path);
	await ensureSocketPathAvailable(socketPath);

	const pendingSockets: Socket[] = [];
	let permissionsReady = false;
	const server: Server = createServer({ pauseOnConnect: true }, (socket) => {
		socket.setEncoding("utf8");
		let request = "";
		let settled = false;
		socket.on("data", (chunk: string) => {
			if (settled) return;
			request += chunk;
			if (Buffer.byteLength(request) > MAX_REQUEST_BYTES) {
				settled = true;
				socket.end(`${JSON.stringify({ error: "Request exceeds 1 MiB limit" })}\n`);
				return;
			}
			const newline = request.indexOf("\n");
			if (newline < 0) return;
			settled = true;
			void (async () => {
				try {
					const response = await handler(JSON.parse(request.slice(0, newline)) as unknown);
					socket.end(`${JSON.stringify(response)}\n`);
				} catch (error) {
					socket.end(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
				}
			})();
		});
		socket.on("error", () => socket.destroy());
		if (permissionsReady) socket.resume();
		else pendingSockets.push(socket);
	});

	const identity = await listenWithPrivatePermissions(server, socketPath);
	permissionsReady = true;
	for (const socket of pendingSockets.splice(0)) socket.resume();
	return {
		path: socketPath,
		close: async () => {
			await closeServer(server);
			await unlinkIfOwned(socketPath, identity.dev, identity.ino);
		},
	};
}

/** Bridge each socket connection to a fresh RPC subprocess without interpreting its JSONL protocol. */
export async function listenRpcSocketBridge(
	path: string,
	command: string,
	args: string[] = [],
): Promise<{ path: string; close(): Promise<void> }> {
	if (process.platform === "win32") throw new Error("Unix domain sockets are unavailable on Windows");
	const socketPath = resolve(path);
	await ensureSocketPathAvailable(socketPath);

	const connections = new Set<{ socket: Socket; child: ChildProcess }>();
	const pendingSockets: Socket[] = [];
	let permissionsReady = false;
	const connect = (socket: Socket) => {
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
		const connection = { socket, child };
		connections.add(connection);
		let clientClosed = false;
		const cleanup = () => {
			connections.delete(connection);
			if (!clientClosed && child.exitCode === null && child.signalCode === null) child.kill();
		};
		socket.on("data", (chunk) => {
			if (!child.stdin.write(chunk)) socket.pause();
		});
		child.stdin.on("drain", () => socket.resume());
		socket.once("end", () => {
			clientClosed = true;
			child.stdin.end();
		});
		child.stdout.on("data", (chunk: Buffer) => {
			if (!socket.destroyed) socket.write(chunk);
		});
		child.stdout.once("end", () => {
			if (!socket.destroyed) socket.end();
		});
		socket.once("close", cleanup);
		socket.once("error", cleanup);
		child.once("error", () => socket.destroy());
		child.once("close", () => {
			if (!socket.destroyed) socket.end();
		});
		socket.resume();
	};
	const server: Server = createServer({ pauseOnConnect: true, allowHalfOpen: true }, (socket) => {
		if (permissionsReady) connect(socket);
		else pendingSockets.push(socket);
	});

	const identity = await listenWithPrivatePermissions(server, socketPath);
	permissionsReady = true;
	for (const socket of pendingSockets.splice(0)) connect(socket);
	return {
		path: socketPath,
		close: async () => {
			for (const { socket, child } of connections) {
				socket.destroy();
				if (child.exitCode === null && child.signalCode === null) child.kill();
			}
			for (const socket of pendingSockets.splice(0)) socket.destroy();
			await closeServer(server);
			await unlinkIfOwned(socketPath, identity.dev, identity.ino);
		},
	};
}

async function ensureSocketPathAvailable(socketPath: string): Promise<void> {
	try {
		await lstat(socketPath);
		throw new Error(`Refusing to replace existing RPC socket path: ${socketPath}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function listenWithPrivatePermissions(server: Server, socketPath: string): Promise<{ dev: number; ino: number }> {
	const { promise, resolve: resolveListen, reject } = Promise.withResolvers<void>();
	server.once("error", reject);
	server.listen(socketPath, () => resolveListen());
	try {
		await promise;
		await chmod(socketPath, 0o600);
		const stat = await lstat(socketPath);
		return { dev: stat.dev, ino: stat.ino };
	} catch (error) {
		await closeServer(server);
		throw error;
	}
}

async function closeServer(server: Server): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	server.close((error) => (error ? reject(error) : resolve()));
	return promise;
}

async function unlinkIfOwned(socketPath: string, dev: number, ino: number): Promise<void> {
	const current = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
		return undefined;
	});
	if (current?.dev === dev && current.ino === ino) await unlink(socketPath);
}
