import { describe, expect, it } from "vitest";
import { resolveSlashCommandCompatibility } from "../src/core/slash-command-compat.ts";

describe("slash command compatibility aliases", () => {
	it("rewrites listed compatibility commands without losing family arguments", () => {
		expect(resolveSlashCommandCompatibility("/xomp-mcp list")).toEqual({
			kind: "alias",
			origin: "omp",
			command: "mcp",
			argumentsText: "list",
		});
		expect(resolveSlashCommandCompatibility("/xopencode-compact")).toEqual({
			kind: "alias",
			origin: "opencode",
			command: "compact",
			argumentsText: "",
		});
	});

	it("resolves every registered compatibility alias to a real Noushi command", async () => {
		const { BUILTIN_SLASH_COMMANDS } = await import("../src/core/slash-commands.ts");
		const { slashCommandCompatibilityAliases } = await import("../src/core/slash-command-compat.ts");
		const dispatchable = new Set([
			...BUILTIN_SLASH_COMMANDS.map((command) => command.name),
			"mcp", // Registered by the built-in MCP extension.
			// Namespaced aliases for the bundled OMP prompt templates.
			"cl",
			"deslop",
			"dup",
			"is",
			"pr",
			"sa",
			"wr",
		]);
		for (const [name, alias] of Object.entries(slashCommandCompatibilityAliases)) {
			expect(
				BUILTIN_SLASH_COMMANDS.some((command) => command.name === name && command.origin),
				name,
			).toBe(true);
			expect(dispatchable.has(alias.command), `${name} -> ${alias.command}`).toBe(true);
			const resolved = resolveSlashCommandCompatibility(`/${name} args`);
			expect(resolved, name).toEqual({
				kind: "alias",
				origin: alias.origin,
				command: alias.command,
				argumentsText: alias.argumentsPrefix ? `${alias.argumentsPrefix} args` : "args",
			});
		}
	});

	it("does not reinterpret normal prompts, unknown names, or unsupported destructive commands", () => {
		expect(resolveSlashCommandCompatibility("review /xomp-undo")).toBeUndefined();
		expect(resolveSlashCommandCompatibility("/xomp-security scan")).toBeUndefined();
		expect(resolveSlashCommandCompatibility("/xopencode-undo")).toBeUndefined();
		expect(resolveSlashCommandCompatibility("/xopencode-clear")).toBeUndefined();
	});

	it("maps OpenCode thinking to the existing thinking-visibility toggle", () => {
		expect(resolveSlashCommandCompatibility("/xopencode-thinking")).toEqual({
			kind: "toggle-thinking",
			origin: "opencode",
		});
		expect(resolveSlashCommandCompatibility("/xopencode-thinking high")).toBeUndefined();
	});
});
