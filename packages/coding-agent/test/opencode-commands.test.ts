import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import opencodeCommands from "../src/extensions/opencode-commands.ts";

function setup() {
	const commands = new Map<string, RegisteredCommand>();
	opencodeCommands({
		registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
			commands.set(name, {
				name,
				...command,
				sourceInfo: createSyntheticSourceInfo("<builtin:opencode-commands>", { source: "builtin" }),
			}),
	} as unknown as ExtensionAPI);
	let editorText = "draft";
	let toolsExpanded = false;
	const editor = vi.fn(async (_title: string, prefill?: string) => prefill);
	const setEditorText = vi.fn((text: string) => {
		editorText = text;
	});
	const ctx = {
		cwd: "/tmp",
		isProjectTrusted: () => true,
		mode: "tui",
		hasUI: true,
		ui: {
			getToolsExpanded: () => toolsExpanded,
			setToolsExpanded: (value: boolean) => {
				toolsExpanded = value;
			},
			getEditorText: () => editorText,
			setEditorText,
			editor,
			confirm: vi.fn(async () => true),
			notify: vi.fn(),
		},
		sessionManager: {
			getHeader: () => ({ id: "session-1", cwd: "/work", timestamp: "2026-01-01T00:00:00.000Z" }),
			getSessionName: () => undefined,
			buildSessionProjection: () => ({
				entries: [],
				thinkingLevel: "off",
				model: null,
				messages: [
					{ role: "user", content: "Please inspect this." },
					{ role: "assistant", content: [{ type: "text", text: "Found a result." }] },
				],
			}),
		},
	} as unknown as ExtensionCommandContext;
	return { commands, ctx, editor, setEditorText, getToolsExpanded: () => toolsExpanded };
}

describe("OpenCode local commands", () => {
	it("registers namespaced commands with OpenCode attribution", () => {
		const { commands } = setup();
		expect([...commands.keys()]).toEqual(["xopencode-init", "init", "xopencode-help", "help"]);
		for (const command of commands.values()) expect(command.description).toContain("OpenCode compatibility");
		expect([...commands.values()].every((command) => command.sourceInfo.source === "builtin")).toBe(true);
	});
	it("lists session commands grouped by source in the editor", async () => {
		const { ctx, editor } = setup();
		const helpCommands = new Map<string, RegisteredCommand>();
		opencodeCommands({
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
				helpCommands.set(name, {
					name,
					...command,
					sourceInfo: createSyntheticSourceInfo("<builtin:opencode-commands>", { source: "builtin" }),
				}),
			getCommands: () => [
				{
					name: "settings",
					description: "Open settings menu",
					source: "extension" as const,
					sourceInfo: createSyntheticSourceInfo("builtin:settings", { source: "builtin" }),
				},
				{
					name: "greet",
					description: "Greet someone",
					source: "prompt" as const,
					sourceInfo: createSyntheticSourceInfo("/home/u/commands/greet.md", { source: "command" }),
				},
			],
		} as unknown as ExtensionAPI);
		await helpCommands.get("xopencode-help")!.handler("", ctx);
		const markdown = editor.mock.calls.at(-1)![1]!;
		expect(markdown).toContain("## built-in");
		expect(markdown).toContain("- /settings — Open settings menu");
		expect(markdown).toContain("## /home/u/commands/greet.md");
		expect(markdown).toContain("- /greet <args> — Greet someone");
	});

	it("previews and confirms a trusted AGENTS.md write", async () => {
		const { commands, ctx, editor } = setup();
		const dir = mkdtempSync(join(tmpdir(), "noushi-init-"));
		try {
			Object.assign(ctx, { cwd: dir });
			const content = "# Project instructions\n";
			editor.mockResolvedValueOnce(content);
			await commands.get("xopencode-init")!.handler("", ctx);
			expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(content);
			expect(editor).toHaveBeenNthCalledWith(
				2,
				expect.stringContaining("Review diff"),
				expect.stringContaining("+# Project instructions"),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
