import { type ChildProcess, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Node, type Program, parse } from "acorn";
import { Type } from "typebox";
import { trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

function filterProcessOutput(output: string): string {
	const noise =
		/^(?:npm warn|npm notice|DeprecationWarning|ExperimentalWarning|Debugger attached|Waiting for the debugger)\b.*$/gm;
	return output
		.replace(noise, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const processSchema = Type.Object({
	action: Type.Union([Type.Literal("start"), Type.Literal("poll"), Type.Literal("stop")]),
	id: Type.Optional(Type.String()),
	command: Type.Optional(Type.String()),
	waitMs: Type.Optional(
		Type.Number({
			minimum: 0,
			maximum: 30000,
			description: "Poll wait duration in milliseconds, up to 30 seconds; returns on output, exit, or timeout",
		}),
	),
});

interface ManagedProcess {
	child: ChildProcess;
	output: string;
	exitCode?: number | null;
	changed: Array<() => void>;
}

const processes = new Map<string, ManagedProcess>();
let nextProcessId = 1;

/** Create the managed background process tool. */
export function createProcessTool(cwd: string) {
	const definition: ToolDefinition<any> = {
		name: "process",
		label: "process",
		description: "Start, poll, or stop a managed background process.",
		parameters: processSchema,
		async execute(
			_id,
			args: { action: "start" | "poll" | "stop"; id?: string; command?: string; waitMs?: number },
			signal,
		) {
			if (args.action === "start") {
				if (!args.command) throw new Error("start requires command");
				const id = String(nextProcessId++);
				const child = spawn(args.command, {
					cwd,
					shell: true,
					detached: process.platform !== "win32",
					stdio: ["ignore", "pipe", "pipe"],
				});
				const managed: ManagedProcess = { child, output: "", changed: [] };
				const notify = () => {
					for (const resolve of managed.changed.splice(0)) resolve();
				};
				const append = (chunk: Buffer) => {
					managed.output = `${managed.output}${chunk.toString("utf8")}`.slice(-64 * 1024);
					notify();
				};
				child.stdout?.on("data", append);
				child.stderr?.on("data", append);
				child.on("close", (code) => {
					managed.exitCode = code;
					if (child.pid) untrackDetachedChildPid(child.pid);
					notify();
				});
				child.on("error", (error) => {
					managed.output += `\\n${error.message}`;
					managed.exitCode = null;
					notify();
				});
				if (child.pid) trackDetachedChildPid(child.pid);
				processes.set(id, managed);
				signal?.addEventListener("abort", () => stopManaged(managed), { once: true });
				return { content: [{ type: "text", text: `Started process ${id}` }], details: { id } };
			}
			const managed = args.id ? processes.get(args.id) : undefined;
			if (!managed) throw new Error(`Unknown process ${args.id ?? ""}`);
			if (args.action === "stop") {
				stopManaged(managed);
				return { content: [{ type: "text", text: `Stopped process ${args.id}` }], details: { id: args.id } };
			}
			if (args.waitMs && managed.exitCode === undefined) {
				const { promise, resolve } = Promise.withResolvers<void>();
				managed.changed.push(resolve);
				const timer = setTimeout(resolve, args.waitMs);
				const abort = () => resolve();
				signal?.addEventListener("abort", abort, { once: true });
				try {
					await promise;
				} finally {
					clearTimeout(timer);
					signal?.removeEventListener("abort", abort);
				}
			}
			return {
				content: [
					{
						type: "text",
						text: `status=${managed.exitCode === undefined ? "running" : `exited(${managed.exitCode})`}\n${filterProcessOutput(managed.output) || "(no output)"}`,
					},
				],
				details: { id: args.id, exitCode: managed.exitCode },
			};
		},
	};
	return wrapToolDefinition(definition);
}

function stopManaged(managed: ManagedProcess): void {
	const pid = managed.child.pid;
	if (!pid || managed.exitCode !== undefined) return;
	try {
		if (process.platform === "win32") managed.child.kill("SIGTERM");
		else process.kill(-pid, "SIGTERM");
	} catch {}
	const timer = setTimeout(() => {
		if (managed.exitCode !== undefined) return;
		try {
			if (process.platform === "win32") managed.child.kill("SIGKILL");
			else process.kill(-pid, "SIGKILL");
		} catch {}
	}, 1000);
	timer.unref();
}

const astEditSchema = Type.Object({ path: Type.String(), symbol: Type.String(), replacement: Type.String() });

/** Create the AST-aware JavaScript declaration replacement tool. */
export function createAstEditTool(cwd: string) {
	const definition: ToolDefinition<any> = {
		name: "ast_edit",
		label: "ast_edit",
		description: "Replace one JavaScript AST declaration selected by its declared identifier.",
		parameters: astEditSchema,
		async execute(_id, args: { path: string; symbol: string; replacement: string }) {
			const path = resolve(cwd, args.path);
			const sourceText = await readFile(path, "utf8");
			const parsed = parse(sourceText, { ecmaVersion: "latest", sourceType: "module" }) as Program;
			const matches: Node[] = [];
			for (const node of parsed.body) {
				const declaration =
					node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration"
						? node.declaration
						: node;
				if (!declaration) continue;
				if (
					(declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") &&
					declaration.id?.name === args.symbol
				)
					matches.push(declaration);
				else if (
					declaration.type === "VariableDeclaration" &&
					declaration.declarations.some((item) => item.id.type === "Identifier" && item.id.name === args.symbol)
				)
					matches.push(declaration);
			}
			if (matches.length !== 1)
				throw new Error(`Expected one AST declaration named ${args.symbol}; found ${matches.length}`);
			parse(args.replacement, { ecmaVersion: "latest", sourceType: "module" });
			const node = matches[0];
			await writeFile(path, sourceText.slice(0, node.start) + args.replacement + sourceText.slice(node.end), "utf8");
			return {
				content: [{ type: "text", text: `Replaced AST declaration ${args.symbol} in ${path}` }],
				details: { path, symbol: args.symbol },
			};
		},
	};
	return wrapToolDefinition(definition);
}

const sqliteSchema = Type.Object({ path: Type.String(), query: Type.String() });

/** Create the read-only SQLite inspection tool. */
export function createSqliteInspectTool(cwd: string) {
	const definition: ToolDefinition<any> = {
		name: "sqlite_inspect",
		label: "sqlite_inspect",
		description:
			"Inspect a SQLite database using a read-only connection. Only one SELECT, WITH query, or PRAGMA statement is accepted.",
		parameters: sqliteSchema,
		async execute(_id, args: { path: string; query: string }) {
			if (!/^\s*(select|with|pragma)\b/i.test(args.query) || args.query.includes(";"))
				throw new Error("Only a single read-only SELECT, WITH, or PRAGMA statement is allowed");
			const path = resolve(cwd, args.path);
			const db = new DatabaseSync(path, { readOnly: true });
			try {
				db.exec("PRAGMA query_only = ON");
				const rows = db.prepare(args.query).all();
				return {
					content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
					details: { path, rows: rows.length },
				};
			} finally {
				db.close();
			}
		},
	};
	return wrapToolDefinition(definition);
}
