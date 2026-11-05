import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	collapseOutput,
	formatAnsiDiff,
	formatTelemetryBar,
	PromptHistory,
	resolveEditorAction,
} from "../src/core/terminal/index.ts";

describe("terminal UX features", () => {
	test("formats ansi diffs with line colors", () => {
		const diff = formatAnsiDiff("a.ts", "b.ts", "hello\nworld", "hello\nthere\nworld");
		expect(diff).toContain("+there");
		expect(diff).toContain("\x1b[32m"); // green
	});

	test("prompt history handles reverse search", () => {
		const history = new PromptHistory();
		history.add("test build");
		history.add("deploy production");
		expect(history.search("deploy")?.text).toBe("deploy production");
		expect(history.search("build")?.text).toBe("test build");
	});
	test("persists prompt history and reloads it in original order", () => {
		const directory = mkdtempSync(join(tmpdir(), "noushi-history-"));
		const historyPath = join(directory, "history.json");
		try {
			const history = new PromptHistory(historyPath);
			history.add("first prompt");
			history.add("second prompt");
			expect(readFileSync(historyPath, "utf8")).toContain("first prompt");
			expect(new PromptHistory(historyPath).toArray()).toEqual(["first prompt", "second prompt"]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("collapses lengthy outputs", () => {
		const longOutput = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
		const collapsed = collapseOutput(longOutput, 20, 5, 5);
		expect(collapsed.collapsed).toBe(true);
		expect(collapsed.hiddenLines).toBe(40);
		expect(collapsed.text).toContain("[... folded 40 lines ...]");
	});

	test("formats telemetry status line", () => {
		const bar = formatTelemetryBar({
			model: "Noushi",
			contextTokens: 12000,
			maxTokens: 128000,
			totalCostUsd: 0.045,
			activeTool: "read",
		});
		expect(bar).toContain("[Noushi]");
		expect(bar).toContain("ctx: 12,000/128,000 (9%)");
		expect(bar).toContain("cost: $0.0450");
		expect(bar).toContain("tool: read");
	});

	test("resolves vim normal mode switches", () => {
		expect(resolveEditorAction("i", "vim-normal")?.newMode).toBe("vim-insert");
		expect(resolveEditorAction("Escape", "vim-insert")?.newMode).toBe("vim-normal");
	});
});
