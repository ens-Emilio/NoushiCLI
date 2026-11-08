import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";

/**
 * Represents a prompt template loaded from a markdown file
 */
export interface PromptTemplate {
	name: string;
	description: string;
	argumentHint?: string;
	content: string;
	sourceInfo: SourceInfo;
	filePath: string;
}

export interface OpenCodeCommand extends PromptTemplate {
	resourceType: "opencode-command";
	agent?: string;
	model?: string;
	subtask?: boolean;
	shellOptIn: boolean;
}

/**
 * Parse command arguments respecting quoted strings (bash-style)
 * Returns array of arguments
 */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	// Tracks whether a token has started, so quoted empty strings ("" or '') are kept as arguments
	let hasToken = false;
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];

		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
			hasToken = true;
		} else if (/\s/.test(char)) {
			if (hasToken) {
				args.push(current);
				current = "";
				hasToken = false;
			}
		} else {
			current += char;
			hasToken = true;
		}
	}

	if (hasToken) {
		args.push(current);
	}

	return args;
}

/**
 * Substitute argument placeholders in template content
 * Supports:
 * - $1, $2, ... for positional args
 * - $@ and $ARGUMENTS for all args
 * - ${N:-default} for positional arg N with default when missing/empty
 * - ${@:-default} and ${ARGUMENTS:-default} for all args with a default when empty
 * - ${@:N} for args from Nth onwards (bash-style slicing)
 * - ${@:N:L} for L args starting from Nth
 *
 * Note: Replacement happens on the template string only. Argument and default values
 * containing patterns like $1, $@, or $ARGUMENTS are NOT recursively substituted.
 */
export function substituteArgs(content: string, args: string[]): string {
	const allArgs = args.join(" ");

	return content.replace(
		/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		(_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
			if (defaultTarget) {
				const value =
					defaultTarget === "@" || defaultTarget === "ARGUMENTS" ? allArgs : args[parseInt(defaultTarget, 10) - 1];
				return value ? value : defaultValue;
			}

			if (sliceStart) {
				let start = parseInt(sliceStart, 10) - 1; // Convert to 0-indexed (user provides 1-indexed)
				// Treat 0 as 1 (bash convention: args start at 1)
				if (start < 0) start = 0;

				if (sliceLength) {
					const length = parseInt(sliceLength, 10);
					return args.slice(start, start + length).join(" ");
				}
				return args.slice(start).join(" ");
			}

			if (simple === "ARGUMENTS" || simple === "@") {
				return allArgs;
			}

			const index = parseInt(simple, 10) - 1;
			return args[index] ?? "";
		},
	);
}

function loadTemplateFromFile(
	filePath: string,
	sourceInfo: SourceInfo,
): { template: PromptTemplate | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];
	let rawContent: string;
	try {
		rawContent = readFileSync(filePath, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to read prompt template file";
		diagnostics.push({ type: "warning", message, path: filePath });
		return { template: null, diagnostics };
	}

	let frontmatter: Record<string, unknown>;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter(rawContent));
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to parse prompt template file";
		diagnostics.push({ type: "warning", message, path: filePath });
		return { template: null, diagnostics };
	}

	const name = basename(filePath).replace(/\.md$/, "");

	// Get description from frontmatter or first non-empty line
	let description = typeof frontmatter.description === "string" ? frontmatter.description : "";
	if (!description) {
		const firstLine = body.split("\n").find((line) => line.trim());
		if (firstLine) {
			// Truncate if too long
			description = firstLine.slice(0, 60);
			if (firstLine.length > 60) description += "...";
		}
	}

	const argumentHint = typeof frontmatter["argument-hint"] === "string" ? frontmatter["argument-hint"] : undefined;
	return {
		template: {
			name,
			description,
			...(argumentHint && { argumentHint }),
			content: body,
			sourceInfo,
			filePath,
		},
		diagnostics,
	};
}

/**
 * Scan a directory for .md files (non-recursive) and load them as prompt templates.
 */
function loadTemplatesFromDir(dir: string, getSourceInfo: (filePath: string) => SourceInfo): LoadPromptTemplatesResult {
	const templates: PromptTemplate[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	if (!existsSync(dir)) {
		return { templates, diagnostics };
	}

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = join(dir, entry.name);

			// For symlinks, check if they point to a file
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isFile = stats.isFile();
				} catch {
					// Broken symlink, skip it
					continue;
				}
			}

			if (isFile && entry.name.endsWith(".md")) {
				const result = loadTemplateFromFile(fullPath, getSourceInfo(fullPath));
				if (result.template) {
					templates.push(result.template);
				}
				diagnostics.push(...result.diagnostics);
			}
		}
	} catch {
		return { templates, diagnostics };
	}

	return { templates, diagnostics };
}

export interface LoadOpenCodeCommandsOptions {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
	reservedNames?: ReadonlySet<string>;
}

export interface LoadOpenCodeCommandsResult {
	commands: OpenCodeCommand[];
	diagnostics: ResourceDiagnostic[];
}

/** Discover OpenCode markdown commands without merging them into prompt templates. */
export function loadOpenCodeCommands(options: LoadOpenCodeCommandsOptions): LoadOpenCodeCommandsResult {
	const cwd = resolvePath(options.cwd);
	const globalDir = join(resolvePath(options.agentDir), "commands");
	const projectDir = resolve(cwd, CONFIG_DIR_NAME, "commands");
	const commands: OpenCodeCommand[] = [];
	const diagnostics: ResourceDiagnostic[] = [];
	const reservedNames = options.reservedNames ?? new Set<string>();
	const readDir = (dir: string, scope: "user" | "project"): void => {
		if (!existsSync(dir)) return;
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (!entry.name.endsWith(".md")) continue;
				const filePath = join(dir, entry.name);
				try {
					if (!(entry.isFile() || (entry.isSymbolicLink() && statSync(filePath).isFile()))) continue;
					const { frontmatter, body } = parseFrontmatter(readFileSync(filePath, "utf8"));
					for (const key of ["description", "agent", "model"] as const) {
						if (frontmatter[key] !== undefined && typeof frontmatter[key] !== "string") {
							throw new Error(`frontmatter ${key} must be a string`);
						}
					}
					if (frontmatter.subtask !== undefined && typeof frontmatter.subtask !== "boolean") {
						throw new Error("frontmatter subtask must be a boolean");
					}
					if (frontmatter.shell !== undefined && typeof frontmatter.shell !== "boolean") {
						throw new Error("frontmatter shell must be a boolean");
					}
					const stem = basename(entry.name, ".md");
					const name = `xopencode-${stem}`;
					if (reservedNames.has(`/${name}`) || commands.some((command) => command.name === name)) {
						diagnostics.push({
							type: "warning",
							message: `OpenCode command collision ignored: /${name}`,
							path: filePath,
						});
						continue;
					}
					const absolutePath = resolvePath(filePath);
					commands.push({
						name,
						description: (frontmatter.description as string | undefined) ?? "",
						content: body,
						filePath: absolutePath,
						sourceInfo: createSyntheticSourceInfo(absolutePath, {
							source: "OpenCode compatibility",
							scope,
							baseDir: dir,
						}),
						resourceType: "opencode-command",
						agent: frontmatter.agent as string | undefined,
						model: frontmatter.model as string | undefined,
						subtask: frontmatter.subtask as boolean | undefined,
						shellOptIn: frontmatter.shell === true,
					});
				} catch (error) {
					diagnostics.push({
						type: "warning",
						message: error instanceof Error ? error.message : "failed to load command",
						path: filePath,
					});
				}
			}
		} catch (error) {
			diagnostics.push({
				type: "warning",
				message: error instanceof Error ? error.message : "failed to read command directory",
				path: dir,
			});
		}
	};
	readDir(globalDir, "user");
	if (options.projectTrusted) readDir(projectDir, "project");
	return { commands, diagnostics };
}

/** Expand command arguments and cwd-rooted file references. Shell interpolation is rejected without a callable safety path. */
export function expandOpenCodeCommand(command: OpenCodeCommand, args: string[], cwd: string): string {
	if (command.subtask) throw new Error(`/${command.name} declares subtask:true, but no subtask runtime is available`);
	if (command.agent)
		throw new Error(`/${command.name} declares agent:${command.agent}, but command agent selection is unavailable`);
	if (command.model)
		throw new Error(`/${command.name} declares model:${command.model}, but command model selection is unavailable`);
	if (/!`[^`]*`/.test(command.content)) {
		if (!command.shellOptIn)
			throw new Error(`/${command.name} uses shell interpolation without frontmatter shell: true`);
		if (command.sourceInfo.scope === "project")
			throw new Error(
				`/${command.name} shell interpolation requires a callable trusted-project bash confirmation path`,
			);
		throw new Error(
			`/${command.name} shell interpolation is unavailable because no callable bash confirmation path exists`,
		);
	}
	const withArgs = substituteArgs(command.content, args);
	return withArgs.replace(/@([^\s"'`]+)/g, (reference, path: string) => {
		if (path.startsWith("@")) return reference;
		const root = realpathSync(resolve(cwd));
		const target = resolve(root, path);
		if (isAbsolute(path) || relative(root, target).startsWith(`..${sep}`) || relative(root, target) === "..") {
			throw new Error(`/${command.name} file reference escapes the working directory: @${path}`);
		}
		const realTarget = realpathSync(target);
		if (realTarget !== root && !realTarget.startsWith(`${root}${sep}`)) {
			throw new Error(`/${command.name} file reference escapes the working directory: @${path}`);
		}
		return readFileSync(realTarget, "utf8");
	});
}
export function expandOpenCodeCommandInvocation(text: string, commands: OpenCodeCommand[], cwd: string): string {
	const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	if (!match) return text;
	const command = commands.find((item) => item.name === match[1]);
	return command ? expandOpenCodeCommand(command, parseCommandArgs(match[2] ?? ""), cwd) : text;
}

export interface LoadPromptTemplatesOptions {
	/** Working directory for project-local templates. */
	cwd: string;
	/** Agent config directory for global templates. */
	agentDir: string;
	/** Explicit prompt template paths (files or directories). */
	promptPaths: string[];
	/** Include default prompt directories. */
	includeDefaults: boolean;
}

export interface LoadPromptTemplatesResult {
	templates: PromptTemplate[];
	diagnostics: ResourceDiagnostic[];
}

/**
 * Load all prompt templates from:
 * 1. Global: agentDir/prompts/
 * 2. Project: cwd/{CONFIG_DIR_NAME}/prompts/
 * 3. Explicit prompt paths
 */
export function loadPromptTemplates(options: LoadPromptTemplatesOptions): LoadPromptTemplatesResult {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);
	const promptPaths = options.promptPaths;
	const includeDefaults = options.includeDefaults;

	const templates: PromptTemplate[] = [];
	const diagnostics: ResourceDiagnostic[] = [];
	const addResult = (result: LoadPromptTemplatesResult): void => {
		templates.push(...result.templates);
		diagnostics.push(...result.diagnostics);
	};

	const globalPromptsDir = join(resolvedAgentDir, "prompts");
	const projectPromptsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "prompts");

	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};

	const getSourceInfo = (resolvedPath: string): SourceInfo => {
		if (isUnderPath(resolvedPath, globalPromptsDir)) {
			return createSyntheticSourceInfo(resolvedPath, {
				source: "local",
				scope: "user",
				baseDir: globalPromptsDir,
			});
		}
		if (isUnderPath(resolvedPath, projectPromptsDir)) {
			return createSyntheticSourceInfo(resolvedPath, {
				source: "local",
				scope: "project",
				baseDir: projectPromptsDir,
			});
		}
		return createSyntheticSourceInfo(resolvedPath, {
			source: "local",
			baseDir: statSync(resolvedPath).isDirectory() ? resolvedPath : dirname(resolvedPath),
		});
	};

	if (includeDefaults) {
		addResult(loadTemplatesFromDir(globalPromptsDir, getSourceInfo));
		addResult(loadTemplatesFromDir(projectPromptsDir, getSourceInfo));
	}

	// 3. Load explicit prompt paths
	for (const rawPath of promptPaths) {
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		if (!existsSync(resolvedPath)) {
			continue;
		}

		try {
			const stats = statSync(resolvedPath);
			if (stats.isDirectory()) {
				addResult(loadTemplatesFromDir(resolvedPath, getSourceInfo));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const result = loadTemplateFromFile(resolvedPath, getSourceInfo(resolvedPath));
				if (result.template) {
					templates.push(result.template);
				}
				diagnostics.push(...result.diagnostics);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read prompt template path";
			diagnostics.push({ type: "warning", message, path: resolvedPath });
		}
	}

	return { templates, diagnostics };
}

/**
 * Expand a prompt template if it matches a template name.
 * Returns the expanded content or the original text if not a template.
 */
export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
	if (!text.startsWith("/")) return text;

	const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	if (!match) return text;

	const templateName = match[1];
	const argsString = match[2] ?? "";

	const template = templates.find((t) => t.name === templateName);
	if (template) {
		const args = parseCommandArgs(argsString);
		return substituteArgs(template.content, args);
	}

	return text;
}
