import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createAstEditTool, createProcessTool, createSqliteInspectTool } from "../src/core/tools/advanced.ts";

describe("Wave 3 Advanced Tools", () => {
	it("replaces AST declarations using typescript compiler AST", async () => {
		const dir = tmpdir();
		const file = join(dir, `ast-test-${Date.now()}.ts`);
		writeFileSync(file, "export function original() { return 1; }\nexport const keep = 2;\n", "utf8");
		const tool = createAstEditTool(dir);
		const result = await tool.execute("call-1", {
			path: file,
			symbol: "original",
			replacement: "export function original() { return 42; }",
		});
		expect(result.content[0]?.type).toBe("text");
		expect((result.content[0] as { text: string }).text).toContain("Replaced AST declaration original");
	});

	it("fails when an AST declaration symbol is missing", async () => {
		const dir = tmpdir();
		const file = join(dir, `ast-test-${Date.now()}.ts`);
		writeFileSync(file, "export const onlyMe = 1;\n", "utf8");
		const tool = createAstEditTool(dir);
		await expect(
			tool.execute("call-2", {
				path: file,
				symbol: "missing",
				replacement: "export function missing() {}",
			}),
		).rejects.toThrow("Expected one AST declaration named missing; found 0");
	});

	it("runs read-only sqlite queries", async () => {
		const dir = tmpdir();
		const file = join(dir, `sqlite-test-${Date.now()}.db`);
		const db = new DatabaseSync(file);
		db.exec("CREATE TABLE notes (id INT, text TEXT); INSERT INTO notes VALUES (1, 'hello');");
		db.close();

		const tool = createSqliteInspectTool(dir);
		const result = await tool.execute("call-3", {
			path: file,
			query: "SELECT text FROM notes WHERE id = 1",
		});
		expect((result.content[0] as { text: string }).text).toContain("hello");
	});

	it("rejects mutating sqlite statements", async () => {
		const dir = tmpdir();
		const file = join(dir, `sqlite-test-${Date.now()}.db`);
		const tool = createSqliteInspectTool(dir);
		await expect(
			tool.execute("call-4", {
				path: file,
				query: "DROP TABLE notes",
			}),
		).rejects.toThrow("Only a single read-only SELECT, WITH, or PRAGMA statement is allowed");
	});

	it("starts, polls, and stops a managed background process", async () => {
		const tool = createProcessTool(tmpdir());
		const startResult = await tool.execute("call-5", {
			action: "start",
			command: "node -e 'setInterval(() => {}, 1000)'",
		});
		const match = (startResult.content[0] as { text: string }).text.match(/Started process (\d+)/);
		expect(match).toBeTruthy();
		const id = match![1];

		const pollResult = await tool.execute("call-6", { action: "poll", id, waitMs: 1000 });
		expect((pollResult.content[0] as { text: string }).text).toContain("status=running");
		const stopResult = await tool.execute("call-7", { action: "stop", id });
		expect((stopResult.content[0] as { text: string }).text).toContain(`Stopped process ${id}`);
	});
	it("filters semantic noise from managed process output", async () => {
		const tool = createProcessTool(tmpdir());
		const startResult = await tool.execute("call-8", {
			action: "start",
			command: "printf 'npm warn noise\\nreal result\\n'",
		});
		const id = (startResult.content[0] as { text: string }).text.match(/Started process (\d+)/)![1];
		const pollResult = await tool.execute("call-9", { action: "poll", id, waitMs: 5000 });
		expect((pollResult.content[0] as { text: string }).text).toContain("real result");
		expect((pollResult.content[0] as { text: string }).text).not.toContain("npm warn noise");
	});
});
