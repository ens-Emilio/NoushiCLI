import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { FilesystemPanel } from "../src/modes/interactive/components/filesystem-panel.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark");
const roots: string[] = [];
afterEach(() => {
	setKeybindings(new KeybindingsManager());
	initTheme("dark");
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("FilesystemPanel", () => {
	it("lists files, enters directories, moves to parent, and closes", () => {
		const root = mkdtempSync(join(tmpdir(), "noushi-files-panel-"));
		roots.push(root);
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "README.md"), "readme");
		setKeybindings(new KeybindingsManager());
		const panel = new FilesystemPanel(root);
		const rendered = () => panel.render(60).join("\n");
		for (const width of [24, 48, 80]) {
			expect(panel.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		expect(rendered()).toContain("src/");
		expect(rendered()).toContain("README.md");
		panel.handleInput("\r");
		expect(rendered()).toContain("src");
		panel.handleInput("\x1b[D");
		expect(rendered()).toContain("README.md");
		let closed = false;
		panel.onClose = () => {
			closed = true;
		};
		panel.handleInput("\x1b");
		expect(closed).toBe(true);
	});
});
