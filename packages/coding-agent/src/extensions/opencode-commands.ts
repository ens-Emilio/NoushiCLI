/** OpenCode-compatible slash commands backed by existing Noushi APIs. */

import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Diff from "diff";
import type { ExtensionCommandContext, ExtensionFactory } from "../core/extensions/types.ts";
import { isSyntheticPath } from "../core/source-info.ts";

const unavailable = (command: string): Error =>
	new Error(`${command} requires an interactive UI and is unavailable in this mode.`);

/** Draft or update AGENTS.md after showing a diff and receiving project-trust and overwrite confirmation. */
async function initAgentsFile(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.isProjectTrusted()) throw new Error("/xopencode-init requires a trusted project.");
	const target = join(ctx.cwd, "AGENTS.md");
	const existing = existsSync(target) ? readFileSync(target, "utf8") : undefined;
	if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
		throw new Error(`/xopencode-init will not write through symlink ${target}`);
	}
	const draft =
		existing ??
		`# AGENTS.md\n\nProject instructions for Noushi. Describe how this codebase is built, tested, and reviewed.\n`;
	const reviewed = await ctx.ui.editor(`Edit ${target}`, draft);
	if (reviewed === undefined || reviewed === existing) return;
	const diff = Diff.createPatch("AGENTS.md", existing ?? "", reviewed, "current", "proposed");
	if ((await ctx.ui.editor(`Review diff for ${target}`, diff)) === undefined) return;
	if (!(await ctx.ui.confirm("Write AGENTS.md?", target))) return;
	writeFileSync(target, reviewed.endsWith("\n") ? reviewed : `${reviewed}\n`, { flag: existing ? "w" : "wx" });
	ctx.ui.notify(`Wrote ${target}`);
}

const opencodeCommands: ExtensionFactory = (pi) => {
	const register = (bareName: string, def: Parameters<typeof pi.registerCommand>[1], aliasWithBare = true) => {
		pi.registerCommand(`xopencode-${bareName}`, def);
		if (aliasWithBare) {
			pi.registerCommand(bareName, def);
		}
	};

	register("init", {
		description: "Draft or update AGENTS.md with an editor preview and confirmation (OpenCode compatibility)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) throw unavailable("/init");
			await initAgentsFile(ctx);
		},
	});
	register("help", {
		description: "List all commands available in this session (OpenCode compatibility)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) throw unavailable("/help");
			const sections = new Map<string, string[]>();
			for (const command of pi.getCommands()) {
				const label = `/${command.name}${command.source === "extension" ? "" : " <args>"}`;
				const sourcePath = command.sourceInfo.path;
				const source = isSyntheticPath(sourcePath) ? "built-in" : sourcePath;
				const lines = sections.get(source) ?? [];
				lines.push(`${label}${command.description ? ` — ${command.description}` : ""}`);
				sections.set(source, lines);
			}
			const markdown = [...sections.entries()]
				.map(
					([source, commands]) =>
						`## ${source}\n\n${commands
							.sort()
							.map((line) => `- ${line}`)
							.join("\n")}`,
				)
				.join("\n\n");
			await ctx.ui.editor("Available commands in this session", markdown);
		},
	});
};

export default opencodeCommands;
