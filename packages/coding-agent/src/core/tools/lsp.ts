import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";

const lspSchema = Type.Object({
	operation: Type.Union([Type.Literal("definition"), Type.Literal("references"), Type.Literal("diagnostics")]),
	file: Type.String({ description: "Source file path, relative to the current working directory" }),
	line: Type.Optional(Type.Number({ description: "1-based source line for definition/references" })),
	character: Type.Optional(Type.Number({ description: "1-based source column for definition/references" })),
});

export type LspToolInput = Static<typeof lspSchema>;

export interface LspToolOptions {
	/** Executable language server command. It must speak LSP over stdio. */
	command: string;
	args?: string[];
	languageId?: string;
}

interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { message?: string };
}

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
}

/** Launches a language server for each query and supports definitions, references, and diagnostics. */
export function createLspToolDefinition(cwd: string, options: LspToolOptions): ToolDefinition<typeof lspSchema> {
	return {
		name: "lsp",
		label: "lsp",
		description:
			"Query a stdio Language Server Protocol server for symbol definitions, references, or file diagnostics.",
		promptSnippet: "Query language server definitions, references, and diagnostics",
		parameters: lspSchema,
		async execute(_toolCallId, input: LspToolInput, signal?: AbortSignal, _onUpdate?, ctx?: ExtensionContext) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const root = ctx?.cwd || cwd;
			const file = path.resolve(root, input.file);
			const uri = pathToFileURL(file).href;
			const text = await readFile(file, "utf8");
			const position = {
				line: Math.max(0, Math.floor((input.line ?? 1) - 1)),
				character: Math.max(0, Math.floor((input.character ?? 1) - 1)),
			};
			const method = input.operation === "definition" ? "textDocument/definition" : "textDocument/references";
			const child = spawn(options.command, options.args ?? [], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
			let stderr = "";
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});
			let buffer = Buffer.alloc(0);
			let nextId = 1;
			let diagnostics: unknown[] | undefined;
			let diagnosticsResolve: ((value: unknown[]) => void) | undefined;
			let failed: Error | undefined;
			const pending = new Map<number, PendingRequest>();
			const send = (message: JsonRpcMessage) => {
				const body = Buffer.from(JSON.stringify(message));
				child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
				child.stdin.write(body);
			};
			const notify = (name: string, params: unknown) => send({ jsonrpc: "2.0", method: name, params });
			const request = (name: string, params: unknown) => {
				const { promise, resolve, reject } = Promise.withResolvers<unknown>();
				const id = nextId++;
				pending.set(id, { resolve, reject });
				send({ jsonrpc: "2.0", id, method: name, params });
				return promise;
			};
			const consume = () => {
				while (true) {
					const separator = buffer.indexOf("\r\n\r\n");
					if (separator < 0) return;
					const header = buffer.subarray(0, separator).toString("ascii");
					const length = Number(header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i)?.[1]);
					if (!Number.isSafeInteger(length) || length < 0) throw new Error("Invalid LSP Content-Length header");
					if (buffer.length < separator + 4 + length) return;
					const body = buffer.subarray(separator + 4, separator + 4 + length);
					buffer = buffer.subarray(separator + 4 + length);
					const message = JSON.parse(body.toString("utf8")) as JsonRpcMessage;
					if (message.method === "textDocument/publishDiagnostics") {
						const params = message.params;
						diagnostics =
							params &&
							typeof params === "object" &&
							"diagnostics" in params &&
							Array.isArray(params.diagnostics)
								? params.diagnostics
								: [];
						diagnosticsResolve?.(diagnostics);
					} else if (typeof message.id === "number") {
						const waiter = pending.get(message.id);
						if (waiter) {
							pending.delete(message.id);
							if (message.error) waiter.reject(new Error(message.error.message ?? "LSP request failed"));
							else waiter.resolve(message.result);
						}
					}
				}
			};
			child.stdout.on("data", (chunk: Buffer) => {
				buffer = Buffer.concat([buffer, chunk]);
				try {
					consume();
				} catch (error) {
					failed = error instanceof Error ? error : new Error(String(error));
					child.kill();
				}
			});
			child.on("error", (error) => {
				failed = error;
				for (const waiter of pending.values()) waiter.reject(error);
				pending.clear();
			});
			child.on("exit", (code) => {
				const error = failed ?? new Error(`Language server exited (${code})${stderr ? `: ${stderr.trim()}` : ""}`);
				for (const waiter of pending.values()) waiter.reject(error);
				pending.clear();
			});
			const abort = () => child.kill();
			signal?.addEventListener("abort", abort, { once: true });
			let diagnosticsTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				await request("initialize", {
					processId: process.pid,
					rootUri: pathToFileURL(root).href,
					capabilities: { textDocument: { publishDiagnostics: { relatedInformation: true } } },
				});
				notify("initialized", {});
				notify("textDocument/didOpen", {
					textDocument: { uri, languageId: options.languageId ?? path.extname(file).slice(1), version: 1, text },
				});
				let result: unknown;
				if (input.operation === "diagnostics") {
					if (diagnostics === undefined) {
						const { promise, resolve } = Promise.withResolvers<unknown[]>();
						diagnosticsResolve = resolve;
						diagnosticsTimer = setTimeout(resolve, 5000, []);
						diagnostics = await promise;
					}
					result = diagnostics;
				} else {
					result = await request(method, {
						textDocument: { uri },
						position,
						...(input.operation === "references" ? { context: { includeDeclaration: true } } : {}),
					});
				}
				await request("shutdown", null);
				notify("exit", null);
				child.stdin.end();
				return { content: [{ type: "text", text: JSON.stringify(result ?? [], null, 2) }], details: undefined };
			} catch (error) {
				child.kill();
				if (signal?.aborted) throw new Error("Operation aborted");
				throw error;
			} finally {
				if (diagnosticsTimer) clearTimeout(diagnosticsTimer);
				signal?.removeEventListener("abort", abort);
				if (child.exitCode === null) child.kill();
			}
		},
	};
}

export function createLspTool(cwd: string, options: LspToolOptions): TypeBoxAgentTool<typeof lspSchema> {
	return wrapToolDefinition(createLspToolDefinition(cwd, options));
}
