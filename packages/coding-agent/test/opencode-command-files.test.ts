import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	expandOpenCodeCommand,
	expandOpenCodeCommandInvocation,
	loadOpenCodeCommands,
	loadPromptTemplates,
} from "../src/core/prompt-templates.ts";

let root: string;
let cwd: string;
let agentDir: string;

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

function setup(): void {
	root = mkdtempSync(join(tmpdir(), "noushi-opencode-"));
	cwd = join(root, "project");
	agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
}

function command(name: string, content: string, scope: "user" | "project" = "user") {
	const dir = scope === "user" ? join(agentDir, "commands") : join(cwd, ".noushi", "commands");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.md`), content);
}

describe("OpenCode command files", () => {
	it("discovers global and trusted project resources separately from prompt templates", () => {
		setup();
		command("global", "global body");
		command("project", "project body", "project");
		mkdirSync(join(agentDir, "prompts"), { recursive: true });
		writeFileSync(join(agentDir, "prompts", "prompt.md"), "prompt body");

		const { commands } = loadOpenCodeCommands({ cwd, agentDir, projectTrusted: true });
		const prompts = loadPromptTemplates({ cwd, agentDir, promptPaths: [], includeDefaults: true });

		expect(commands.map(({ name }) => name)).toEqual(["xopencode-global", "xopencode-project"]);
		expect(commands.every((item) => item.resourceType === "opencode-command")).toBe(true);
		expect(prompts.templates.map(({ name }) => name)).toContain("prompt");
		expect(prompts.templates.map(({ name }) => name)).not.toContain("xopencode-global");
	});

	it("uses global precedence, namespaced invocation, and argument placeholders", () => {
		setup();
		command("same", "global $1 / $ARGUMENTS");
		command("same", "project body", "project");
		const { commands } = loadOpenCodeCommands({ cwd, agentDir, projectTrusted: true });

		expect(expandOpenCodeCommandInvocation("/xopencode-same first second", commands, cwd)).toBe(
			"global first / first second",
		);
		expect(expandOpenCodeCommandInvocation("/same first", commands, cwd)).toBe("/same first");
	});

	it("ignores untrusted project commands and validates frontmatter fields", () => {
		setup();
		command("project", "secret", "project");
		command("malformed", "---\ndescription: [invalid\n---\nbody");
		command("wrong-type", "---\ndescription: 42\n---\nbody");
		const denied = loadOpenCodeCommands({ cwd, agentDir, projectTrusted: false });
		expect(denied.commands).toHaveLength(0);
		const trusted = loadOpenCodeCommands({ cwd, agentDir, projectTrusted: true });
		expect(trusted.commands.map(({ name }) => name)).toEqual(["xopencode-project"]);
		expect(trusted.diagnostics).toHaveLength(2);
	});

	it("expands relative file references and rejects traversal and symlink escapes", () => {
		setup();
		command("read", "File: @notes.txt");
		writeFileSync(join(cwd, "notes.txt"), "inside");
		const loaded = loadOpenCodeCommands({ cwd, agentDir, projectTrusted: true }).commands[0];
		expect(expandOpenCodeCommand(loaded, [], cwd)).toBe("File: inside");
		expect(() => expandOpenCodeCommand({ ...loaded, content: "@../outside.txt" }, [], cwd)).toThrow(/escapes/);
		const outside = join(root, "outside.txt");
		writeFileSync(outside, "outside");
		symlinkSync(outside, join(cwd, "escape.txt"));
		expect(() => expandOpenCodeCommand({ ...loaded, content: "@escape.txt" }, [], cwd)).toThrow(/escapes/);
	});

	it("requires shell opt-in and rejects opted-in shell without a callable safety path", () => {
		setup();
		command("raw", "!`echo unsafe`");
		command("allowed", "---\nshell: true\n---\n!`echo unsafe`");
		const { commands } = loadOpenCodeCommands({ cwd, agentDir, projectTrusted: true });
		expect(() => expandOpenCodeCommand(commands.find(({ name }) => name === "xopencode-raw")!, [], cwd)).toThrow(
			/shell: true/,
		);
		expect(() => expandOpenCodeCommand(commands.find(({ name }) => name === "xopencode-allowed")!, [], cwd)).toThrow(
			/no callable bash confirmation path/,
		);
	});

	it("enforces shell opt-in plus project trust and reports namespaced collisions", () => {
		setup();
		command("project-shell", "---\nshell: true\n---\n!`echo unsafe`", "project");
		command("settings", "this is a namespaced command, not /settings");
		const denied = loadOpenCodeCommands({ cwd, agentDir, projectTrusted: false });
		expect(denied.commands.map(({ name }) => name)).toEqual(["xopencode-settings"]);
		const trusted = loadOpenCodeCommands({
			cwd,
			agentDir,
			projectTrusted: true,
			reservedNames: new Set(["/xopencode-settings"]),
		});
		expect(trusted.commands.map(({ name }) => name)).toEqual(["xopencode-project-shell"]);
		expect(trusted.diagnostics[0]?.message).toContain("collision");
		expect(() => expandOpenCodeCommand(trusted.commands[0], [], cwd)).toThrow(
			/trusted-project bash confirmation path/,
		);
	});

	it("fails explicitly for agent, model, and subtask metadata that cannot be applied", () => {
		setup();
		command("agent", "---\nagent: reviewer\n---\nbody");
		command("model", "---\nmodel: provider/model\n---\nbody");
		command("subtask", "---\nsubtask: true\n---\nbody");
		const { commands } = loadOpenCodeCommands({ cwd, agentDir, projectTrusted: true });
		expect(() => expandOpenCodeCommand(commands[0], [], cwd)).toThrow("agent selection is unavailable");
		expect(() => expandOpenCodeCommand(commands[1], [], cwd)).toThrow("model selection is unavailable");
		expect(() => expandOpenCodeCommand(commands[2], [], cwd)).toThrow("no subtask runtime is available");
	});
});
