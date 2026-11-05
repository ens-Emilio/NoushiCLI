export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export { createLspTool, createLspToolDefinition, type LspToolInput, type LspToolOptions } from "./lsp.ts";
export {
	createLocalPowerShellOperations,
	createPowerShellTool,
	createPowerShellToolDefinition,
	type PowerShellOperations,
	type PowerShellSpawnContext,
	type PowerShellSpawnHook,
	type PowerShellToolDetails,
	type PowerShellToolInput,
	type PowerShellToolOptions,
} from "./powershell.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import { createLspTool, createLspToolDefinition } from "./lsp.ts";

export { createAstEditTool, createProcessTool, createSqliteInspectTool } from "./advanced.ts";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import { createAstEditTool, createProcessTool, createSqliteInspectTool } from "./advanced.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import type { LspToolOptions } from "./lsp.ts";
import { createPowerShellTool, createPowerShellToolDefinition, type PowerShellToolOptions } from "./powershell.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";
export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName =
	| "read"
	| "bash"
	| "powershell"
	| "edit"
	| "write"
	| "grep"
	| "find"
	| "ls"
	| "process"
	| "ast_edit"
	| "sqlite_inspect"
	| "lsp";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"process",
	"ast_edit",
	"sqlite_inspect",
	"lsp",
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	powershell?: PowerShellToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
	lsp?: LspToolOptions;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	if (toolName === "process") return createProcessTool(cwd) as unknown as ToolDef;
	if (toolName === "ast_edit") return createAstEditTool(cwd) as unknown as ToolDef;
	if (toolName === "sqlite_inspect") return createSqliteInspectTool(cwd) as unknown as ToolDef;
	if (toolName === "lsp") {
		if (!options?.lsp) throw new Error("The lsp tool requires a configured language server command");
		return createLspToolDefinition(cwd, options.lsp) as unknown as ToolDef;
	}
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "powershell":
			return createPowerShellToolDefinition(cwd, options?.powershell);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	if (toolName === "process") return createProcessTool(cwd);
	if (toolName === "ast_edit") return createAstEditTool(cwd);
	if (toolName === "sqlite_inspect") return createSqliteInspectTool(cwd);
	if (toolName === "lsp") {
		if (!options?.lsp) throw new Error("The lsp tool requires a configured language server command");
		return createLspTool(cwd, options.lsp);
	}
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "powershell":
			return createPowerShellTool(cwd, options?.powershell);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}
export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
		createProcessTool(cwd) as unknown as ToolDef,
		createAstEditTool(cwd) as unknown as ToolDef,
		createSqliteInspectTool(cwd) as unknown as ToolDef,
		...(options?.lsp ? [createLspToolDefinition(cwd, options.lsp) as unknown as ToolDef] : []),
	];
}
export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
		createSqliteInspectTool(cwd) as unknown as ToolDef,
	];
}
export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<string, ToolDef> {
	const tools = {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		powershell: createPowerShellToolDefinition(cwd, options?.powershell),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
		process: createProcessTool(cwd) as unknown as ToolDef,
		ast_edit: createAstEditTool(cwd) as unknown as ToolDef,
		sqlite_inspect: createSqliteInspectTool(cwd) as unknown as ToolDef,
	};
	return options?.lsp ? { ...tools, lsp: createLspToolDefinition(cwd, options.lsp) as unknown as ToolDef } : tools;
}
export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
		createProcessTool(cwd),
		createAstEditTool(cwd),
		createSqliteInspectTool(cwd),
		...(options?.lsp ? [createLspTool(cwd, options.lsp)] : []),
	];
}
export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
		createSqliteInspectTool(cwd),
	];
}
export function createAllTools(cwd: string, options?: ToolsOptions): Record<string, Tool> {
	const tools = {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		powershell: createPowerShellTool(cwd, options?.powershell),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
		process: createProcessTool(cwd),
		ast_edit: createAstEditTool(cwd),
		sqlite_inspect: createSqliteInspectTool(cwd),
	};
	return options?.lsp ? { ...tools, lsp: createLspTool(cwd, options.lsp) } : tools;
}
