import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { type AdvisorModelClient, AdvisorRole } from "../core/advisor-role.ts";
import { BrowserService, resolveBrowserBinary } from "../core/browser-service.ts";
import { type CollabIdentityFull, generateCollabIdentity } from "../core/collab-crypto.ts";
import { CollabGuest, CollabHost } from "../core/collab-session.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../core/extensions/types.ts";
import { MemoryStore } from "../core/memory-store.ts";
import { detectComputerStatus, detectLiveStatus } from "../core/platform-status.ts";
import {
	comparePlan,
	createPlan,
	importSarif,
	type StoredSecurityPlan,
	scanProject,
	toSarif,
} from "../core/security/scanner.ts";
import { type ContextEditEntry, SessionManager } from "../core/session-manager.ts";
import { checkCommandPolicy, runSshCommand } from "../core/ssh-executor.ts";
import { SshHostStore } from "../core/ssh-hosts.ts";
import { getUsageCostBreakdown } from "../core/usage-totals.ts";

/** The browser session lives for the extension module's lifetime; one at a time. */
let ompBrowserSession: BrowserService | undefined;
/** The advisor role, created by /xomp-advisor on; one per extension module. */
let ompAdvisorRole: AdvisorRole | undefined;
/** The active collaboration host room; one at a time. */
let ompCollabHost: CollabHost | undefined;
/** The active collaboration guest session; one at a time. */
let ompCollabGuest: CollabGuest | undefined;

/** Load the collaboration identity from ~/.noushi/agent/collab-identity.json, generating the
 * full (Ed25519 + X25519) pair on first use. The identity file persists both key types. */
function loadOrCreateCollabIdentity(): CollabIdentityFull {
	const path = join(getAgentDir(), "collab-identity.json");
	if (!existsSync(path)) {
		const full = generateCollabIdentity();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(full, null, "\t")}\n`, { mode: 0o600 });
		return full;
	}
	// The stored file has the full shape; identity-level helpers cover the simple case.
	return JSON.parse(readFileSync(path, "utf8")) as CollabIdentityFull;
}

interface OmpTodo {
	id: string;
	text: string;
	status: "open" | "done" | "deleted";
	createdAt: string;
}

type ObjectiveKind = "goal" | "plan";
type ObjectiveStatus = "active" | "paused" | "dropped" | "completed";

interface ObjectiveState {
	kind: ObjectiveKind;
	text: string;
	status: ObjectiveStatus;
	/** Advisory cost target; this compatibility layer does not enforce provider billing caps. */
	budget?: number;
	previousTools?: string[];
	updatedAt: string;
}

function isObjectiveState(value: unknown): value is ObjectiveState {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		(record.kind === "goal" || record.kind === "plan") &&
		typeof record.text === "string" &&
		(record.status === "active" ||
			record.status === "paused" ||
			record.status === "dropped" ||
			record.status === "completed") &&
		(record.budget === undefined ||
			(typeof record.budget === "number" && Number.isFinite(record.budget) && record.budget > 0)) &&
		(record.previousTools === undefined ||
			(Array.isArray(record.previousTools) && record.previousTools.every((tool) => typeof tool === "string"))) &&
		typeof record.updatedAt === "string"
	);
}

function latestObjective(
	ctx: Pick<ExtensionContext, "sessionManager">,
	kind: ObjectiveKind,
): ObjectiveState | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (
			entry.type === "custom" &&
			entry.customType === "noushi.omp-objective" &&
			isObjectiveState(entry.data) &&
			entry.data.kind === kind
		) {
			return entry.data;
		}
	}
	return undefined;
}

function saveObjective(pi: ExtensionAPI, state: ObjectiveState): void {
	pi.appendEntry("noushi.omp-objective", { ...state, updatedAt: new Date().toISOString() });
}

function readWorkspaceFolders(ctx: ExtensionCommandContext): string[] {
	const path = resolve(ctx.cwd, ".noushi-workspace.json");
	if (!existsSync(path)) return [];
	if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing workspace file symlink: ${path}`);
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (typeof value !== "object" || value === null || !("folders" in value) || !Array.isArray(value.folders)) {
		throw new Error(`Invalid workspace file ${path}: expected a folders array`);
	}
	if (!value.folders.every((folder): folder is string => typeof folder === "string" && folder.trim().length > 0)) {
		throw new Error(`Invalid workspace file ${path}: folders must be non-empty paths`);
	}
	return value.folders;
}

function writeWorkspaceFolders(ctx: ExtensionCommandContext, folders: string[]): void {
	if (!ctx.isProjectTrusted()) throw new Error("Workspace directory changes require a trusted project.");
	const path = resolve(ctx.cwd, ".noushi-workspace.json");
	if (existsSync(path) && lstatSync(path).isSymbolicLink())
		throw new Error(`Refusing workspace file symlink: ${path}`);
	writeFileSync(path, `${JSON.stringify({ folders }, null, 2)}\n`);
}
function readTodos(entries: ReturnType<ExtensionCommandContext["sessionManager"]["getEntries"]>): OmpTodo[] {
	return entries.flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== "noushi.omp-todo" || !isOmpTodo(entry.data)) return [];
		return [entry.data];
	});
}

function isOmpTodo(value: unknown): value is OmpTodo {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === "string" &&
		record.id.length > 0 &&
		typeof record.text === "string" &&
		record.text.trim().length > 0 &&
		(record.status === "open" || record.status === "done" || record.status === "deleted") &&
		typeof record.createdAt === "string" &&
		Number.isFinite(Date.parse(record.createdAt))
	);
}

function todoArgs(args: string): { action: string; value: string } {
	const trimmed = args.trim();
	const split = trimmed.search(/\s/u);
	return split < 0
		? { action: trimmed || "list", value: "" }
		: { action: trimmed.slice(0, split), value: trimmed.slice(split).trim() };
}
/** Prompt for a missing command argument in the UI; without a UI, keep the usage error. */
async function promptForArg(
	ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">,
	usage: string,
	title: string,
	placeholder?: string,
): Promise<string | undefined> {
	if (!ctx.hasUI) throw new Error(usage);
	return ctx.ui.input(title, placeholder);
}
function currentTodos(ctx: ExtensionCommandContext): OmpTodo[] {
	const latest = new Map<string, OmpTodo>();
	for (const todo of readTodos(ctx.sessionManager.getEntries())) latest.set(todo.id, todo);
	return [...latest.values()].filter((todo) => todo.status !== "deleted");
}

function validateTodoFile(value: unknown): OmpTodo[] {
	if (!Array.isArray(value) || !value.every(isOmpTodo))
		throw new Error("Todo import must be a JSON array of valid todo records.");
	return value;
}

interface OmpCorrection {
	id: string;
	text: string;
	scope: "session" | "global";
	status: "active" | "forgotten";
	createdAt: string;
}

function readCorrections(ctx: Pick<ExtensionContext, "sessionManager">): OmpCorrection[] {
	const byId = new Map<string, OmpCorrection>();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (
			entry.type === "custom" &&
			entry.customType === "noushi.correction" &&
			typeof entry.data === "object" &&
			entry.data !== null &&
			"id" in entry.data &&
			typeof (entry.data as { id: unknown }).id === "string"
		) {
			byId.set((entry.data as { id: string }).id, entry.data as OmpCorrection);
		}
	}
	return [...byId.values()].filter((c) => c.status === "active");
}

const SAFE_PLAN_TOOLS: Readonly<Record<string, true>> = {
	find: true,
	grep: true,
	ls: true,
	lsp: true,
	read: true,
	sqlite_inspect: true,
};

function planTools(pi: ExtensionAPI): string[] {
	return pi
		.getAllTools()
		.filter((tool) => SAFE_PLAN_TOOLS[tool.name] && tool.sourceInfo.source === "builtin")
		.map((tool) => tool.name);
}

const SOURCE = "OMP compatibility (can1357/oh-my-pi, 9b302ef6385ca87587f29a29837b4d511da4fe00)";

/** Map /xomp-force prompt text to a tool's arguments; undefined means required text was missing. */
const FORCE_TOOL_ARGUMENT_MAPPERS: Readonly<Record<string, (prompt: string) => Record<string, unknown> | undefined>> = {
	bash: (prompt) => (prompt ? { command: prompt } : undefined),
	read: (prompt) => (prompt ? { path: prompt } : undefined),
	find: (prompt) => (prompt ? { pattern: prompt } : undefined),
	grep: (prompt) => (prompt ? { pattern: prompt } : undefined),
	ls: (prompt) => (prompt ? { path: prompt } : {}),
};

const FORCE_TOOL_ARG_NAMES: Readonly<Record<string, string>> = {
	bash: "command",
	read: "path",
	find: "pattern",
	grep: "pattern",
	ls: "path",
};

export function formatContextUsage(ctx: Pick<ExtensionCommandContext, "getContextUsage">): string {
	const usage = ctx.getContextUsage();
	if (!usage) return "Context usage is unavailable for the current model.";
	const tokens = usage.tokens === null ? "unknown" : usage.tokens.toLocaleString("en-US");
	const limit = usage.contextWindow.toLocaleString("en-US");
	const percent = usage.percent === null ? "unknown" : `${usage.percent.toFixed(1)}%`;
	return `Context usage: ${tokens}/${limit} tokens (${percent}).`;
}

export function formatSessionUsage(ctx: Pick<ExtensionCommandContext, "sessionManager">): string {
	const entries = getUsageCostBreakdown(ctx.sessionManager.getBranch());
	const totalTokens = entries.reduce((sum, entry) => sum + entry.tokens, 0);
	const totalCost = entries.reduce((sum, entry) => sum + entry.cost, 0);
	const rows = entries.map(
		(entry) => `  ${entry.key}: ${entry.tokens.toLocaleString("en-US")} tokens, $${entry.cost.toFixed(6)}`,
	);
	return [
		`Session usage: ${totalTokens.toLocaleString("en-US")} tokens, $${totalCost.toFixed(6)} total.`,
		...(rows.length ? rows : ["  No usage recorded yet."]),
	].join("\n");
}

function ctxSetting(ctx: Pick<ExtensionContext, "sessionManager">, customType: string): unknown {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "custom" && entry.customType === customType) return entry.data;
	}
	return undefined;
}

/** Build the advisor's model client: resolves the model from the runtime catalog and
 * completes via the shared provider stack. Throws when the model id is unknown. */
function createAdvisorModelClient(
	ctx: Pick<ExtensionCommandContext, "model" | "scopedModels">,
	forcedModelId?: string,
): AdvisorModelClient {
	return {
		complete: async (messages, systemPrompt) => {
			// The scoped model list is resolved by the runtime; the first matching model wins.
			const modelId = forcedModelId ?? ompAdvisorRole?.getConfig()?.model ?? "";
			const match = ctx.scopedModels.find((entry) => entry.model.id === modelId || entry.model.name === modelId);
			const model = match?.model ?? (modelId ? undefined : ctx.model);
			if (!model) throw new Error(`Advisor model not found: ${modelId}. Check /model for available models.`);
			const context = {
				systemPrompt,
				messages: [
					{
						role: "user" as const,
						content: [
							{
								type: "text" as const,
								text: messages.map((message) => `[${message.role}]\n${message.content}`).join("\n\n"),
							},
						],
						timestamp: Date.now(),
					},
				],
			};
			const reply = await completeSimple(model, context);
			const text = reply.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			return {
				text,
				usage: {
					inputTokens: reply.usage?.input ?? 0,
					outputTokens: reply.usage?.output ?? 0,
				},
			};
		},
	};
}

export default function ompCommandsExtension(pi: ExtensionAPI): void {
	pi.on("context", (event, ctx) => {
		const goal = ctx?.sessionManager ? latestObjective(ctx, "goal") : undefined;
		const plan = ctx?.sessionManager ? latestObjective(ctx, "plan") : undefined;
		const active = [
			goal?.status === "active" ? goal : undefined,
			plan?.status === "active" ? plan : undefined,
		].filter((state): state is ObjectiveState => state !== undefined);
		if (active.length === 0) return;
		const instructions = active
			.map(
				(state) =>
					`${state.kind === "plan" ? "Active plan" : "Active goal"}: ${state.text}${state.budget ? ` (session cost cap $${state.budget})` : ""}`,
			)
			.join("\n");
		return {
			messages: [
				...event.messages,
				{
					role: "custom",
					customType: "noushi.omp-objective-context",
					content: [{ type: "text", text: `<noushi_objective>\n${instructions}\n</noushi_objective>` }],
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});
	pi.on("context", (event, ctx) => {
		if (!ctx?.sessionManager) return;
		const corrections = readCorrections(ctx);
		if (corrections.length === 0) return;
		const lines = corrections.map((c) => `- ${c.text}`);
		return {
			messages: [
				...event.messages,
				{
					role: "custom",
					customType: "noushi.omp-corrections-context",
					content: [{ type: "text", text: `<noushi_corrections>\n${lines.join("\n")}\n</noushi_corrections>` }],
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});
	pi.on("context", (event) => {
		const latestBtw = event.messages.findLastIndex(
			(message) => message.role === "custom" && message.customType === "noushi.btw",
		);
		if (latestBtw < 0) return;
		const keepLatest = latestBtw === event.messages.length - 1;
		return {
			messages: event.messages.flatMap((message, index) => {
				if (message.role !== "custom" || message.customType !== "noushi.btw") return [message];
				if (!keepLatest || index !== latestBtw) return [];
				const prefix = "[One-turn side question; answer briefly without changing the main task]\n";
				return [
					{
						...message,
						content:
							typeof message.content === "string"
								? `${prefix}${message.content}`
								: [{ type: "text" as const, text: prefix }, ...message.content],
					},
				];
			}),
		};
	});
	pi.on("session_start", (_event, ctx) => {
		const goal = latestObjective(ctx, "goal");
		pi.setSessionCostLimit(goal?.status === "active" ? goal.budget : undefined);
		const plan = latestObjective(ctx, "plan");
		if (plan?.status === "active") {
			pi.setActiveTools(planTools(pi));
		}
	});
	const register = (name: string, options: Parameters<typeof pi.registerCommand>[1], aliasWithBare = true) => {
		pi.registerCommand(`xomp-${name}`, options);
		if (aliasWithBare) {
			pi.registerCommand(name, options);
		}
	};
	register("goal", {
		description: `Manage a persistent session goal (${SOURCE})`,
		handler: async (args, ctx) => {
			// A bare /goal shows the current goal; /goal set|pause|... mutate it.
			const { action, value } = todoArgs(args.trim() ? args : "show");
			const existing = latestObjective(ctx, "goal");
			if (action === "show") {
				ctx.ui.notify(
					existing && existing.status !== "dropped"
						? `Goal (${existing.status}): ${existing.text}${existing.budget ? `\nBudget: ${existing.budget}` : ""}`
						: "No active goal.",
				);
				return;
			}
			if (action === "set") {
				const objective =
					value ??
					(await promptForArg(
						ctx,
						"Usage: /xomp-goal set <objective>",
						"Set session goal",
						"What outcome do you want?",
					));
				if (!objective) return;
				pi.setSessionCostLimit(existing?.budget);
				saveObjective(pi, {
					kind: "goal",
					text: objective,
					status: "active",
					budget: existing?.budget,
					updatedAt: new Date().toISOString(),
				});
				ctx.ui.notify("Goal set for this session.");
				return;
			}
			if (action === "budget") {
				if (!existing || existing.status === "dropped") throw new Error("Set a goal before changing its budget.");
				const budget = value === "off" ? undefined : Number(value);
				if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0))
					throw new Error("Usage: /xomp-goal budget <positive-number|off>");
				pi.setSessionCostLimit(existing.status === "active" ? budget : undefined);
				saveObjective(pi, { ...existing, budget, updatedAt: new Date().toISOString() });
				ctx.ui.notify(budget === undefined ? "Goal budget cleared." : `Goal budget set to ${budget}.`);
				return;
			}
			if (!["pause", "resume", "drop", "complete"].includes(action) || value)
				throw new Error("Usage: /xomp-goal <set|show|pause|resume|drop|complete|budget> [value]");
			if (!existing || existing.status === "dropped") throw new Error("No goal to update.");
			const status: ObjectiveStatus =
				action === "pause"
					? "paused"
					: action === "resume"
						? "active"
						: action === "complete"
							? "completed"
							: "dropped";
			pi.setSessionCostLimit(status === "active" ? existing.budget : undefined);
			saveObjective(pi, { ...existing, status, updatedAt: new Date().toISOString() });
			ctx.ui.notify(`Goal ${status}.`);
		},
	});
	register("plan", {
		description: `Start a session plan with mutating tools disabled (${SOURCE})`,
		handler: async (args, ctx) => {
			let objective = args.trim();
			if (!objective) {
				const plan = latestObjective(ctx, "plan");
				if (plan && plan.status !== "completed" && plan.status !== "dropped") {
					ctx.ui.notify(`Plan (${plan.status}): ${plan.text}`);
					return;
				}
				const prompted = await promptForArg(
					ctx,
					"Usage: /xomp-plan <objective>",
					"Start session plan",
					"What should the plan achieve?",
				);
				if (!prompted) return;
				objective = prompted;
			}
			if (latestObjective(ctx, "plan")?.status === "active")
				throw new Error("Review or complete the current plan before starting another.");
			const previousTools = pi.getActiveTools();
			pi.setActiveTools(planTools(pi));
			saveObjective(pi, {
				kind: "plan",
				text: objective,
				status: "active",
				previousTools,
				updatedAt: new Date().toISOString(),
			});
			ctx.ui.notify(
				"Plan mode active: mutating tools are disabled. Use /xomp-plan-review to review and restore tools.",
			);
		},
	});
	pi.on("before_provider_request", (event, ctx) => {
		const enabled = ctxSetting(ctx, "noushi.fast-mode");
		if (!enabled || !event.payload || typeof event.payload !== "object") return;
		const payload = event.payload as Record<string, unknown>;
		if (!payload.reasoning || typeof payload.reasoning !== "object") return;
		return { ...payload, reasoning: { ...(payload.reasoning as Record<string, unknown>), effort: "low" } };
	});
	pi.on("context", (event, ctx) => {
		if (ctxSetting(ctx, "noushi.vision") !== "off") return;
		let changed = false;
		const messages = event.messages.map((message) => {
			if (!("content" in message) || typeof message.content === "string") return message;
			const content = message.content.filter((part) => part.type !== "image");
			if (content.length === message.content.length) return message;
			changed = true;
			return { ...message, content };
		});
		return changed ? { messages: messages as AgentMessage[] } : undefined;
	});
	register("fast", {
		description: `Set low reasoning effort for provider requests that expose reasoning.effort (${SOURCE})`,
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			if (action === "status") {
				ctx.ui.notify(
					`Fast mode ${ctxSetting(ctx, "noushi.fast-mode") ? "on" : "off"}; compatible requests use low reasoning effort.`,
				);
				return;
			}
			if (action !== "on" && action !== "off") throw new Error("Usage: /xomp-fast [on|off|status]");
			pi.appendEntry("noushi.fast-mode", action === "on");
			ctx.ui.notify(`Fast mode ${action}.`);
		},
	});
	register("extended-context", {
		description: `Report selected-model context metadata; account entitlement cannot be enabled by the CLI (${SOURCE})`,
		handler: async (args, ctx) => {
			if (args.trim() && args.trim() !== "status")
				throw new Error(
					"Extended context cannot be enabled here: provider entitlement controls are not exposed. Usage: /xomp-extended-context [status]",
				);
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No selected model; catalog context-window metadata is unavailable.", "warning");
				return;
			}
			ctx.ui.notify(
				`Catalog context window for ${model.provider}/${model.id}: ${model.contextWindow.toLocaleString()} tokens. Extended-context entitlement is provider/account controlled and unavailable here.`,
			);
		},
	});
	register("vision", {
		description: `Set image visibility in model context or report catalog input support (${SOURCE})`,
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			if (action === "status" || action === "auto") {
				const supported = ctx.model?.input.includes("image") ?? false;
				ctx.ui.notify(
					`Vision ${ctxSetting(ctx, "noushi.vision") ?? "auto"}; selected model image input ${supported ? "supported" : "not listed in catalog metadata"}.`,
				);
				return;
			}
			if (action !== "on" && action !== "off") throw new Error("Usage: /xomp-vision <on|off|auto|status>");
			pi.appendEntry("noushi.vision", action);
			ctx.ui.notify(
				`Vision ${action}; ${action === "off" ? "images are omitted from model context" : "catalog capabilities still apply"}.`,
			);
		},
	});
	register("guided-goal", {
		description: `Refine a rough objective through up to five optional questions, then set the session goal (${SOURCE})`,
		handler: async (rough, ctx) => {
			const objective = rough.trim();
			if (!objective)
				throw new Error("Usage: /xomp-guided-goal <rough objective> — /goal set <text> skips the questions");
			if (!ctx.hasUI) throw new Error("/xomp-guided-goal requires an interactive UI.");
			const answers: Array<{ label: string; answer: string }> = [];
			for (const [label, question, placeholder] of [
				["Outcome", "What outcome would make this complete?", "Observable result"],
				["Scope", "What should be included or excluded?", "Scope"],
				["Constraints", "What constraints must be respected?", "Constraints"],
				["Verification", "How should completion be verified?", "Checks"],
				["Priority", "Any deadline or priority?", "Optional"],
			] as const) {
				const answer = await ctx.ui.input(question, placeholder);
				if (answer?.trim()) answers.push({ label, answer: answer.trim() });
			}
			const refined = [objective, ...answers.map(({ label, answer }) => `${label}: ${answer}`)].join("\n");
			const reviewed = await ctx.ui.editor("Review refined goal", refined);
			if (reviewed === undefined) return;
			const current = latestObjective(ctx, "goal");
			pi.setSessionCostLimit(current?.budget);
			saveObjective(pi, {
				kind: "goal",
				text: reviewed.trim() || objective,
				status: "active",
				budget: current?.budget,
				updatedAt: new Date().toISOString(),
			});
			ctx.ui.notify(`Goal refined and set.\n${reviewed.trim() || objective}`);
		},
	});
	register("vibe", {
		description: `Set a goal and enter read-only planning mode in one step (${SOURCE})`,
		handler: async (args, ctx) => {
			let objective = args.trim();
			if (!objective) {
				const prompted = await promptForArg(
					ctx,
					"Usage: /xomp-vibe <objective> — sets a goal and enters read-only planning",
					"Start vibe session",
					"What should the vibe session explore?",
				);
				if (!prompted) return;
				objective = prompted;
			}
			if (latestObjective(ctx, "plan")?.status === "active")
				throw new Error("Review or complete the current plan before starting a vibe session.");
			const currentGoal = latestObjective(ctx, "goal");
			const previousTools = pi.getActiveTools();
			pi.setActiveTools(planTools(pi));
			pi.setSessionCostLimit(currentGoal?.budget);
			saveObjective(pi, {
				kind: "goal",
				text: objective,
				status: "active",
				budget: currentGoal?.budget,
				updatedAt: new Date().toISOString(),
			});
			saveObjective(pi, {
				kind: "plan",
				text: objective,
				status: "active",
				previousTools,
				updatedAt: new Date().toISOString(),
			});
			pi.appendEntry("noushi.vibe-session", { objective, status: "active", updatedAt: new Date().toISOString() });
			ctx.ui.notify(
				"Vibe session active: goal set and mutating tools disabled. Use /xomp-plan-review to complete and restore tools.",
			);
		},
	});
	register("plan-review", {
		description: `Review and complete the active plan (${SOURCE})`,
		handler: async (_args, ctx) => {
			const plan = latestObjective(ctx, "plan");
			if (!plan || plan.status !== "active") throw new Error("No active plan to review.");
			if (!ctx.hasUI) throw new Error("Plan review requires an interactive UI.");
			const reviewed = await ctx.ui.editor("Review plan", plan.text);
			if (
				reviewed === undefined ||
				!(await ctx.ui.confirm("Complete plan and restore tools?", "The plan context will stop being injected."))
			)
				return;
			pi.setActiveTools(plan.previousTools ?? []);
			saveObjective(pi, { ...plan, text: reviewed, status: "completed", updatedAt: new Date().toISOString() });
			const activeVibe = ctx.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === "noushi.vibe-session" &&
						typeof entry.data === "object" &&
						entry.data !== null &&
						"objective" in entry.data &&
						entry.data.objective === plan.text,
				);
			if (activeVibe) {
				const goal = latestObjective(ctx, "goal");
				if (goal?.status === "active")
					saveObjective(pi, { ...goal, status: "completed", updatedAt: new Date().toISOString() });
				pi.appendEntry("noushi.vibe-session", {
					objective: plan.text,
					status: "completed",
					updatedAt: new Date().toISOString(),
				});
			}
			ctx.ui.notify(
				activeVibe
					? "Vibe session completed; goal closed and prior tools restored."
					: "Plan completed; the prior tool selection was restored.",
			);
		},
	});
	register("context", {
		description: `Show current context-window usage (${SOURCE})`,
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /xomp-context", "warning");
				return;
			}
			ctx.ui.notify(formatContextUsage(ctx));
		},
	});

	register(
		"session",
		{
			description: `Show current session identity and entry count (${SOURCE})`,
			handler: async (args, ctx) => {
				if (args.trim() && args.trim() !== "info") {
					ctx.ui.notify("Usage: /xomp-session [info]", "warning");
					return;
				}
				ctx.ui.notify(
					[
						`Session: ${ctx.sessionManager.getSessionId() ?? "not saved"}`,
						`Name: ${ctx.sessionManager.getSessionName() ?? "unnamed"}`,
						`Entries: ${ctx.sessionManager.getEntries().length}`,
					].join("\n"),
				);
			},
		},
		false,
	);

	register("tools", {
		description: `List tools currently available to the model (${SOURCE})`,
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /xomp-tools", "warning");
				return;
			}
			const tools = pi.getActiveTools();
			ctx.ui.notify(
				tools.length ? `Active tools:\n${tools.map((tool) => `  ${tool}`).join("\n")}` : "No active tools.",
			);
		},
	});
	register("handoff", {
		description: `Record a reviewed handoff note in the session (${SOURCE})`,
		handler: async (args, ctx) => {
			const projection = ctx.sessionManager.buildSessionProjection();
			const last = projection.messages[projection.messages.length - 1];
			const summary =
				last && (last.role === "user" || last.role === "assistant") && !("customType" in last)
					? typeof last.content === "string"
						? last.content
						: last.content
								.map((part) => (part.type === "text" ? part.text : ""))
								.filter(Boolean)
								.join("\n")
					: "";
			const note = [
				"## Handoff",
				args.trim() ? `Instructions: ${args.trim()}` : undefined,
				summary ? `Last message:\n\n${summary}` : undefined,
			]
				.filter(Boolean)
				.join("\n\n");
			const reviewed = ctx.hasUI ? await ctx.ui.editor("Review handoff note", note) : note;
			if (reviewed === undefined) return;
			pi.appendEntry("noushi.handoff", { note: reviewed });
			ctx.ui.notify("Handoff recorded in the session.");
		},
	});
	register("queue", {
		description: `Show pending steering and follow-up messages (${SOURCE})`,
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /xomp-queue", "warning");
				return;
			}
			const queue = ctx.getQueue?.();
			if (!queue) {
				ctx.ui.notify("Queue details are unavailable in this host.", "warning");
				return;
			}
			ctx.ui.notify(
				[
					`Steering (${queue.steering.length}):`,
					...(queue.steering.length ? queue.steering.map((message) => `  ${message}`) : ["  none"]),
					`Follow-up (${queue.followUp.length}):`,
					...(queue.followUp.length ? queue.followUp.map((message) => `  ${message}`) : ["  none"]),
				].join("\n"),
			);
		},
	});
	register("retry", {
		description: `Retry the last failed prompt (${SOURCE})`,
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /xomp-retry", "warning");
				return;
			}
			if (ctx.lastActivityOutcome?.() !== "error") {
				ctx.ui.notify("The last turn did not fail; nothing to retry.", "warning");
				return;
			}
			const prompt = ctx.lastUserPrompt?.();
			if (!prompt) {
				ctx.ui.notify("The last failed prompt is unavailable.", "warning");
				return;
			}
			await pi.sendUserMessage(prompt);
		},
	});
	register("todo", {
		description: `Manage session-persisted todos: list, add, done, rm, export, import (${SOURCE})`,
		handler: async (args, ctx) => {
			const { action, value } = todoArgs(args);
			const todos = currentTodos(ctx);
			if (action === "list") {
				if (value) throw new Error("Usage: /xomp-todo list");
				ctx.ui.notify(
					todos.length
						? todos.map((todo) => `${todo.status === "done" ? "[x]" : "[ ]"} ${todo.id} ${todo.text}`).join("\n")
						: "No todos.",
				);
				return;
			}
			if (action === "add") {
				const text =
					value ?? (await promptForArg(ctx, "Usage: /xomp-todo add <text>", "Add todo", "What needs to be done?"));
				if (!text) return;
				pi.appendEntry("noushi.omp-todo", {
					id: randomUUID(),
					text: text,
					status: "open",
					createdAt: new Date().toISOString(),
				} satisfies OmpTodo);
				ctx.ui.notify("Todo added.");
				return;
			}
			if (action === "done" || action === "rm") {
				const id =
					value || (todos.length === 1 ? todos[0]!.id : ((await ctx.ui.input(`Todo ${action}`, "Todo id")) ?? ""));
				if (!id) throw new Error(`Usage: /xomp-todo ${action} <id>`);
				const todo = todos.find((item) => item.id === id);
				if (!todo) throw new Error(`Unknown todo id: ${id}`);
				pi.appendEntry("noushi.omp-todo", { ...todo, status: action === "done" ? "done" : "deleted" });
				ctx.ui.notify(action === "done" ? "Todo completed." : "Todo removed.");
				return;
			}
			if (action === "export") {
				if (!ctx.hasUI || !ctx.isProjectTrusted())
					throw new Error("Todo export requires an interactive trusted project.");
				if (!value) throw new Error("Usage: /xomp-todo export <path>");
				const path = resolve(ctx.cwd, value);
				if (existsSync(path) && !(await ctx.ui.confirm("Overwrite todo export?", path))) return;
				writeFileSync(path, `${JSON.stringify(todos, null, 2)}\n`);
				ctx.ui.notify(`Exported ${todos.length} todos to ${path}`);
				return;
			}
			if (action === "import") {
				if (!ctx.hasUI || !ctx.isProjectTrusted())
					throw new Error("Todo import requires an interactive trusted project.");
				if (!value) throw new Error("Usage: /xomp-todo import <path>");
				const imported = validateTodoFile(JSON.parse(readFileSync(resolve(ctx.cwd, value), "utf8")));
				const existingIds = new Set(todos.map((todo) => todo.id));
				const collisions = imported.filter((todo) => existingIds.has(todo.id));
				if (
					collisions.length > 0 &&
					!(await ctx.ui.confirm("Replace matching session todos?", collisions.map((todo) => todo.id).join(", ")))
				) {
					return;
				}
				for (const todo of imported) {
					pi.appendEntry("noushi.omp-todo", todo);
				}
				ctx.ui.notify(`Imported ${imported.length} todos.`);
				return;
			}
			throw new Error("Usage: /xomp-todo <list|add|done|rm|export|import> [value]");
		},
	});
	register("loop", {
		description: `Repeat a prompt a bounded number of times (${SOURCE})`,
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) throw new Error("/xomp-loop cannot start while the agent is already running.");
			const { action, value } = todoArgs(args);
			const count = Number(action);
			if (!Number.isInteger(count) || count < 1 || count > 10 || !value) {
				throw new Error("Usage: /xomp-loop <1-10> <prompt>");
			}
			for (let iteration = 0; iteration < count; iteration++) {
				if (ctx.signal?.aborted) return;
				pi.sendUserMessage(value);
				await ctx.waitForIdle();
				if (ctx.lastActivityOutcome?.() !== "completed") return;
			}
		},
	});
	register("dirs", {
		description: `List context workspace folders (${SOURCE})`,
		handler: async (args, ctx) => {
			if (args.trim()) throw new Error("Usage: /xomp-dirs");
			const folders = readWorkspaceFolders(ctx);
			ctx.ui.notify(
				folders.length ? folders.map((folder) => `  ${folder}`).join("\n") : "No extra workspace folders.",
			);
		},
	});
	register("add-dir", {
		description: `Add a project context folder (${SOURCE})`,
		handler: async (value, ctx) => {
			if (!value.trim()) throw new Error("Usage: /xomp-add-dir <path>");
			if (!ctx.hasUI || !ctx.isProjectTrusted())
				throw new Error("Adding workspace folders requires an interactive trusted project.");
			const candidate = resolve(ctx.cwd, value);
			if (!existsSync(candidate) || !statSync(candidate).isDirectory())
				throw new Error(`Not a directory: ${candidate}`);
			const folders = readWorkspaceFolders(ctx);
			if (folders.some((folder) => resolve(ctx.cwd, folder) === candidate)) {
				ctx.ui.notify(`Already configured: ${candidate}`, "warning");
				return;
			}
			if (!(await ctx.ui.confirm("Add workspace context folder?", candidate))) return;
			writeWorkspaceFolders(ctx, [...folders, relative(ctx.cwd, candidate) || "."]);
			await ctx.reload();
			ctx.ui.notify(`Added workspace context folder: ${candidate}`);
		},
	});
	register("remove-dir", {
		description: `Remove a project context folder (${SOURCE})`,
		handler: async (value, ctx) => {
			if (!value.trim()) throw new Error("Usage: /xomp-remove-dir <path>");
			if (!ctx.hasUI || !ctx.isProjectTrusted())
				throw new Error("Removing workspace folders requires an interactive trusted project.");
			const target = resolve(ctx.cwd, value);
			const folders = readWorkspaceFolders(ctx);
			const remaining = folders.filter((folder) => resolve(ctx.cwd, folder) !== target);
			if (remaining.length === folders.length) throw new Error(`Not configured: ${target}`);
			if (!(await ctx.ui.confirm("Remove workspace context folder?", target))) return;
			writeWorkspaceFolders(ctx, remaining);
			await ctx.reload();
			ctx.ui.notify(`Removed workspace context folder: ${target}`);
		},
	});
	register("move", {
		description: `Move the current session file to a new name in its directory (${SOURCE})`,
		handler: async (args, ctx) => {
			if (!ctx.hasUI) throw new Error("/xomp-move requires an interactive UI.");
			const name = args.trim() || (await ctx.ui.input("Move session file", "New file name"));
			if (!name) return;
			const current = ctx.sessionManager.getSessionFile();
			if (!current) throw new Error("The current session is not persisted, so it cannot be moved.");
			const target = resolve(dirname(current), name.endsWith(".jsonl") ? name : `${name}.jsonl`);
			if (existsSync(target) && !(await ctx.ui.confirm("Overwrite existing session file?", target))) return;
			if (existsSync(target)) unlinkSync(target);
			const moved = ctx.sessionManager.moveTo(target);
			ctx.ui.notify(`Session moved to ${moved}`);
		},
	});
	register("clear", {
		description: `Clear all queued messages and compact the context with explicit clear instructions (${SOURCE})`,
		handler: async (args, ctx) => {
			if (args.trim()) throw new Error("Usage: /xomp-clear");
			if (!ctx.hasUI) throw new Error("/xomp-clear requires an interactive UI.");
			const entryCount = ctx.sessionManager.getEntries().length;
			if (
				!(await ctx.ui.confirm(
					"Clear context?",
					`This clears queued messages and compacts all ${entryCount} entries into a summary. Session history is kept on disk.`,
				))
			) {
				return;
			}
			ctx.compact({
				customInstructions: "Clear the working context. Summarize only that the user requested a fresh start.",
			});
			ctx.ui.notify("Clear queued and compaction started. Use /queue to inspect pending messages.");
		},
	});
	register("drop", {
		description: `Delete a stored session file after typed confirmation (${SOURCE})`,
		handler: async (args, ctx) => {
			if (!ctx.hasUI) throw new Error("/xomp-drop requires an interactive UI.");
			const sessions = await SessionManager.list(ctx.cwd);
			if (sessions.length === 0) {
				ctx.ui.notify("No stored sessions found.", "warning");
				return;
			}
			const wanted = args.trim();
			const candidates = wanted ? sessions.filter((session) => session.id.startsWith(wanted)) : sessions;
			if (candidates.length === 0) {
				ctx.ui.notify(`No session matches "${wanted}".`, "warning");
				return;
			}
			const selected = await ctx.ui.select(
				"Drop which session?",
				candidates.map((session) => `${session.id} — ${session.firstMessage.slice(0, 60)}`),
			);
			if (selected === undefined) return;
			const sessionId = selected.slice(0, selected.indexOf(" —"));
			const session = candidates.find((item) => item.id === sessionId);
			if (!session) return;
			const typed = await ctx.ui.input(`Type the session id to confirm deletion`, session.id);
			if (typed !== session.id) {
				ctx.ui.notify("Confirmation did not match; nothing was deleted.", "warning");
				return;
			}
			SessionManager.deleteSession(session.path, ctx.sessionManager.getSessionFile());
			ctx.ui.notify(`Deleted session ${session.id}.`);
		},
	});
	register("btw", {
		description: `Ask a side question that enters model context for one request only (${SOURCE})`,
		handler: async (question, ctx) => {
			const text =
				question.trim() ||
				(await promptForArg(ctx, "Usage: /xomp-btw <question>", "Side question", "Ask one question"));
			if (!text) return;
			if (!ctx.isIdle())
				throw new Error("/xomp-btw requires an idle session so its one-turn context is unambiguous.");
			await pi.sendMessage({ customType: "noushi.btw", content: text, display: true }, { triggerTurn: true });
		},
	});
	register("shake", {
		description: `Preview and omit image, thinking, or tool-result context without deleting transcript history (${SOURCE})`,
		handler: async (args, ctx) => {
			let strategy = args.trim();
			if (strategy !== "elide" && strategy !== "images" && strategy !== "thinking") {
				if (!ctx.hasUI) throw new Error("Usage: /xomp-shake <elide|images|thinking>");
				strategy = (await ctx.ui.select("Shake context: what to omit?", ["elide", "images", "thinking"])) ?? "";
				if (strategy !== "elide" && strategy !== "images" && strategy !== "thinking") return;
			}
			const projection = ctx.sessionManager.buildSessionProjection();
			const changes: Array<{ targetId: string; replacement: ContextEditEntry["replacement"]; label: string }> = [];
			for (const projected of projection.entries) {
				if (projected.sourceEntry.type !== "message") continue;
				const message = projected.messages[0];
				if (!message || (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult"))
					continue;
				let content: typeof message.content;
				if (strategy === "elide") {
					if (message.role !== "toolResult") continue;
					content = [];
				} else {
					const parts =
						typeof message.content === "string"
							? [{ type: "text" as const, text: message.content }]
							: message.content;
					content = parts.filter((part) =>
						strategy === "images" ? part.type !== "image" : part.type !== "thinking",
					) as typeof message.content;
					if (content.length === parts.length) continue;
				}
				changes.push({
					targetId: projected.sourceEntry.id,
					replacement: content.length === 0 ? null : { content },
					label: `${message.role} ${projected.sourceEntry.id}: ${message.content.length ?? 0} content block(s)`,
				});
			}
			if (changes.length === 0) {
				ctx.ui.notify(`No ${strategy} context entries found.`);
				return;
			}
			const preview = changes.map((change) => `- ${change.label}`).join("\n");
			const reviewed = await ctx.ui.editor(`Preview /xomp-shake ${strategy}`, preview);
			if (
				reviewed === undefined ||
				!(await ctx.ui.confirm(
					"Apply context edits?",
					`${changes.length} projected entry(s) will be omitted or shortened. Transcript history is retained.`,
				))
			)
				return;
			for (const change of changes) pi.appendContextEdit(change.targetId, change.replacement);
			ctx.ui.notify(`Applied ${changes.length} context edit(s); transcript history was retained.`);
		},
	});
	register("force", {
		description: `Force one tool call outside a model turn, recording the result in the transcript (${SOURCE})`,
		handler: async (args, ctx) => {
			let toolName = args.trim().split(/\s+/u)[0] ?? "";
			let promptText = args.trim().slice(toolName.length).trim();
			if (!toolName) {
				const supported = Object.keys(FORCE_TOOL_ARGUMENT_MAPPERS);
				if (!ctx.hasUI) throw new Error("Usage: /xomp-force <tool-name> [prompt]");
				toolName = (await ctx.ui.select("Force which tool?", supported)) ?? "";
				if (!toolName) return;
				promptText =
					(await ctx.ui.input(`Force ${toolName}`, `Arguments (${FORCE_TOOL_ARG_NAMES[toolName]})`)) ?? "";
			}
			if (!pi.getAllTools().some((tool) => tool.name === toolName))
				throw new Error(`Unknown tool: ${toolName}. Use /tools to list available tools.`);
			const argsFor = FORCE_TOOL_ARGUMENT_MAPPERS[toolName];
			if (!argsFor)
				throw new Error(
					`No argument mapping for ${toolName}. Supported: ${Object.keys(FORCE_TOOL_ARGUMENT_MAPPERS).join(", ")}.`,
				);
			const toolArgs = argsFor(promptText);
			if (toolArgs === undefined)
				throw new Error(`Usage: /xomp-force ${toolName} <${FORCE_TOOL_ARG_NAMES[toolName]}>`);
			if (
				!(await ctx.ui.confirm(
					`Force ${toolName}?`,
					`Arguments: ${JSON.stringify(toolArgs)}\nThe result is recorded in the session transcript.`,
				))
			) {
				return;
			}
			const outcome = await ctx.forceToolCall(toolName, toolArgs);
			const text = outcome.result.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			ctx.ui.notify(outcome.isError ? `Forced ${toolName} failed:\n${text}` : `Forced ${toolName}:\n${text}`);
		},
	});
	register("tan", {
		description: `Start background agent work in a child session (${SOURCE})`,
		handler: async (work, ctx) => {
			const prompt = work.trim();
			if (!prompt) throw new Error("Usage: /xomp-tan <work>");
			const registry = ctx.getBackgroundJobs?.();
			if (!registry) throw new Error("Background agent jobs are unavailable in this host.");
			const id = await registry.start(prompt);
			ctx.ui.notify(`Started background job ${id}. Use /xomp-jobs to inspect or cancel.`);
		},
	});
	register("jobs", {
		description: `List, show, cancel, or wait on background agent jobs (${SOURCE})`,
		handler: async (args, ctx) => {
			const registry = ctx.getBackgroundJobs?.();
			if (!registry) throw new Error("Background agent jobs are unavailable in this host.");
			const parts = args.trim().split(/\s+/u).filter(Boolean);
			const action = parts[0] ?? "list";
			if (action === "list") {
				const jobs = registry.list();
				if (jobs.length === 0) {
					ctx.ui.notify("No background jobs.");
					return;
				}
				const rows = jobs.map((job) => `  ${job.id} [${job.state}] ${job.label}`);
				ctx.ui.notify(`Background jobs (${jobs.length}):\n${rows.join("\n")}`);
				return;
			}
			if (action === "cancel") {
				const id = parts[1];
				if (!id) throw new Error("Usage: /xomp-jobs cancel <id>");
				const cancelled = registry.cancel(id);
				ctx.ui.notify(cancelled ? `Cancelled background job ${id}.` : `Job ${id} is not running.`);
				return;
			}
			if (action === "result") {
				const id = parts[1];
				if (!id) throw new Error("Usage: /xomp-jobs result <id>");
				const result = registry.resultOf(id);
				if (!result) {
					ctx.ui.notify(`Job ${id} has not completed yet, or is unknown.`);
					return;
				}
				ctx.ui.notify(`Result of ${id} [${result.state}]:\n${result.text}`);
				return;
			}
			if (action === "wait") {
				const id = parts[1];
				if (!id) throw new Error("Usage: /xomp-jobs wait <id>");
				const result = await registry.waitFor(id);
				ctx.ui.notify(`Settled ${id} [${result.state}]:\n${result.text}`);
				return;
			}
			throw new Error("Usage: /xomp-jobs [list|cancel <id>|result <id>|wait <id>]");
		},
	});
	register("cleanse", {
		description: `Dispatch parallel background fixes for diagnostic errors from the last turn (${SOURCE})`,
		handler: async (args, ctx) => {
			const registry = ctx.getBackgroundJobs?.();
			if (!registry) throw new Error("Cleanse requires background job support.");
			const widen = args.includes("--all");
			const instruction = args.replace("--all", "").trim() || "Fix the errors reported in the last turn.";
			const branch = ctx.sessionManager.getBranch();
			const errors: string[] = [];
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type !== "message") continue;
				if (entry.message.role === "toolResult" && entry.message.isError) {
					const text = entry.message.content
						.filter((part): part is { type: "text"; text: string } => part.type === "text")
						.map((part) => part.text)
						.join("\n");
					if (text) errors.push(`${entry.message.toolName}: ${text}`);
				}
				if (!widen && entry.message.role === "assistant") break;
			}
			if (errors.length === 0) {
				ctx.ui.notify("No diagnostic errors recorded in the last turn.");
				return;
			}
			const count = Math.min(errors.length, 3);
			const jobs: string[] = [];
			for (let i = 0; i < count; i++) {
				const err = errors[i];
				const id = await registry.start(`${instruction}\nError: ${err}`, { label: `cleanse:${i + 1}` });
				jobs.push(id);
			}
			ctx.ui.notify(`Started ${jobs.length} parallel cleanse job(s): ${jobs.join(", ")}. Use /xomp-jobs to track.`);
		},
	});
	register("omfg", {
		description: `Persist a behavioral correction that is injected into future context (${SOURCE})`,
		handler: async (args, ctx) => {
			let trimmed = args.trim();
			const parts = trimmed.split(/\s+/u);
			const sub = parts[0];
			if (sub === "list") {
				const corrections = readCorrections(ctx);
				if (corrections.length === 0) {
					ctx.ui.notify("No active corrections.");
					return;
				}
				const rows = corrections.map((c) => `  ${c.id} [${c.scope}] ${c.text}`);
				ctx.ui.notify(`Active corrections (${corrections.length}):\n${rows.join("\n")}`);
				return;
			}
			if (sub === "forget") {
				const id = parts[1];
				if (!id) throw new Error("Usage: /xomp-omfg forget <id>");
				const existing = readCorrections(ctx).find((c) => c.id === id);
				if (!existing) throw new Error(`Unknown correction id: ${id}`);
				pi.appendEntry("noushi.correction", { ...existing, status: "forgotten" });
				ctx.ui.notify(`Forgot correction ${id}.`);
				return;
			}
			if (!trimmed) {
				const prompted = await promptForArg(
					ctx,
					"Usage: /xomp-omfg <correction text> OR /xomp-omfg list OR /xomp-omfg forget <id>",
					"Record correction",
					"What should Noushi do differently from now on?",
				);
				if (!prompted) return;
				trimmed = prompted;
			}
			let scope: "session" | "global" = "session";
			if (ctx.hasUI) {
				const makeGlobal = await ctx.ui.confirm(
					"Apply correction globally?",
					"Global corrections apply to all sessions in this workspace.",
				);
				if (makeGlobal) scope = "global";
			}
			const correction: OmpCorrection = {
				id: randomUUID().slice(0, 8),
				text: trimmed,
				scope,
				status: "active",
				createdAt: new Date().toISOString(),
			};
			pi.appendEntry("noushi.correction", correction);
			ctx.ui.notify(`Correction recorded [${scope}]: "${trimmed}". It will be injected into future model requests.`);
		},
	});
	register("memory", {
		description: `Remember and recall project-scoped durable memory (${SOURCE})`,
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/u).filter(Boolean);
			const action = parts[0] ?? "view";
			const store = new MemoryStore(join(getAgentDir(), "memory.db"));
			try {
				if (action === "view") {
					const entries = store.view(ctx.cwd);
					if (entries.length === 0) {
						ctx.ui.notify("No memories stored for this project yet. Use /xomp-memory remember <text>.");
						return;
					}
					ctx.ui.notify(
						entries
							.map(
								(entry) =>
									`- [${entry.id.slice(0, 8)}] ${entry.content}${entry.tags.length ? ` (${entry.tags.join(", ")})` : ""}`,
							)
							.join("\n"),
					);
					return;
				}
				if (action === "stats") {
					const stats = store.stats();
					ctx.ui.notify(
						`Memories: ${stats.total} across ${stats.projects} project(s).` +
							(stats.oldest ? `\nOldest: ${stats.oldest}\nNewest: ${stats.newest}` : ""),
					);
					return;
				}
				if (action === "remember") {
					const text = parts.slice(1).join(" ");
					if (!text) throw new Error("Usage: /xomp-memory remember <text>");
					const tags = [...text.matchAll(/#(\w[\w-]*)/gu)].map((match) => match[1]);
					const clean = tags.length ? text : text;
					if (
						!(await ctx.ui.confirm(
							"Store this memory?",
							`${clean}\n\nStored per-project under ${getAgentDir()}/memory.db.`,
						))
					)
						return;
					const id = store.remember(ctx.cwd, clean, tags);
					ctx.ui.notify(`Stored memory [${id.slice(0, 8)}].`);
					return;
				}
				if (action === "recall") {
					const query = parts.slice(1).join(" ");
					const results = store.recall(ctx.cwd, query);
					if (results.length === 0) {
						ctx.ui.notify(`No memories match "${query}".`);
						return;
					}
					ctx.ui.notify(results.map((entry) => `- [${entry.id.slice(0, 8)}] ${entry.content}`).join("\n"));
					return;
				}
				if (action === "forget") {
					const idPrefix = parts[1];
					if (!idPrefix) throw new Error("Usage: /xomp-memory forget <id-prefix>");
					const entries = store.view(ctx.cwd);
					const matches = entries.filter((entry) => entry.id.startsWith(idPrefix));
					if (matches.length === 0) throw new Error(`No memory id starts with "${idPrefix}".`);
					if (matches.length > 1)
						throw new Error(
							`Ambiguous id prefix "${idPrefix}" matches ${matches.length} memories; use more characters.`,
						);
					if (!(await ctx.ui.confirm("Forget this memory?", matches[0].content))) return;
					store.forget(matches[0].id);
					ctx.ui.notify("Memory forgotten.");
					return;
				}
				throw new Error("Usage: /xomp-memory [view|stats|remember <text>|recall <query>|forget <id-prefix>]");
			} finally {
				store.close();
			}
		},
	});
	register("security", {
		description: `Run the local rule-based security scanner and manage SARIF results (${SOURCE})`,
		handler: async (args, ctx) => {
			if (!ctx.isProjectTrusted()) throw new Error("Security scanning requires a trusted project.");
			const parts = args.trim().split(/\s+/u).filter(Boolean);
			const action = parts[0] ?? "scan";
			if (action === "scan") {
				const scope = parts.includes("--working-tree") ? "working-tree" : "project";
				const result = scanProject(ctx.cwd);
				const counts = {
					error: result.findings.filter((f) => f.severity === "error").length,
					warning: result.findings.filter((f) => f.severity === "warning").length,
					note: result.findings.filter((f) => f.severity === "note").length,
				};
				ctx.ui.notify(
					`Security scan (${scope}): ${result.filesScanned} file(s), ${result.findings.length} finding(s) ` +
						`(${counts.error} error, ${counts.warning} warning, ${counts.note} note).\n` +
						(result.findings.length > 0
							? result.findings
									.slice(0, 20)
									.map((f) => `  [${f.severity}] ${f.path}:${f.line} ${f.ruleName}`)
									.join("\n") +
								(result.findings.length > 20 ? `\n  … ${result.findings.length - 20} more` : "")
							: "No findings."),
				);
				return;
			}
			if (action === "export") {
				const output = parts[1];
				if (!output) throw new Error("Usage: /xomp-security export <output.sarif>");
				const result = scanProject(ctx.cwd);
				writeFileSync(resolve(ctx.cwd, output), `${toSarif(result)}\n`);
				ctx.ui.notify(`SARIF report written to ${output} (${result.findings.length} finding(s)).`);
				return;
			}
			if (action === "plan") {
				const planId = parts[1] ?? new Date().toISOString().slice(0, 10).replaceAll("-", "");
				const plansDir = resolve(ctx.cwd, CONFIG_DIR_NAME, "security", "plans");
				mkdirSync(plansDir, { recursive: true });
				const result = scanProject(ctx.cwd);
				const plan = createPlan(planId, result);
				writeFileSync(resolve(plansDir, `${planId}.json`), `${JSON.stringify(plan, null, "\t")}\n`);
				ctx.ui.notify(
					`Security plan ${planId} saved with ${result.findings.length} finding(s) in .noushi/security/plans/.`,
				);
				return;
			}
			if (action === "import") {
				const source = parts[1];
				if (!source) throw new Error("Usage: /xomp-security import <file.sarif>");
				const path = resolve(ctx.cwd, source);
				const imported = importSarif(readFileSync(path, "utf8"), ctx.cwd);
				ctx.ui.notify(
					`Imported ${imported.findings.length} finding(s) from ${source}. Use /xomp-security compare <plan-id> to line them up with a plan.`,
				);
				return;
			}
			if (action === "compare") {
				const planId = parts[1];
				if (!planId) throw new Error("Usage: /xomp-security compare <plan-id>");
				const planPath = resolve(ctx.cwd, CONFIG_DIR_NAME, "security", "plans", `${planId}.json`);
				const plan = JSON.parse(readFileSync(planPath, "utf8")) as StoredSecurityPlan;
				const current = scanProject(ctx.cwd);
				const comparison = comparePlan(plan, current);
				ctx.ui.notify(
					`Plan ${planId} vs current scan: ${comparison.unchanged.length} unchanged, ${comparison.new.length} new, ${comparison.fixed.length} fixed.` +
						(comparison.new.length > 0
							? `\nNew:\n${comparison.new
									.slice(0, 10)
									.map(
										(entry) =>
											`  [${entry.finding.severity}] ${entry.finding.path}:${entry.finding.line} ${entry.finding.ruleName}`,
									)
									.join("\n")}`
							: ""),
				);
				return;
			}
			throw new Error(
				"Usage: /xomp-security [scan [--working-tree]|export <output.sarif>|plan [id]|import <file.sarif>|compare <plan-id>]. Cloud subcommands are unavailable in this local baseline.",
			);
		},
	});
	register("browser", {
		description: `Drive a local Chromium-family browser over CDP with explicit consent (${SOURCE})`,
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/u).filter(Boolean);
			const action = parts[0] ?? "status";
			if (action === "status") {
				const binary = resolveBrowserBinary();
				if (!binary) {
					ctx.ui.notify(
						"Browser unavailable: no Chromium-family binary found. Set CHROMIUM_BIN or install chromium.",
					);
					return;
				}
				ctx.ui.notify(
					`Browser binary: ${binary.path} (${binary.source}). Running: ${ompBrowserSession?.status().running ? "yes" : "no"}.`,
				);
				return;
			}
			if (action === "open") {
				const url = parts[1];
				if (!url) throw new Error("Usage: /xomp-browser open <url>");
				const binary = resolveBrowserBinary();
				if (!binary) throw new Error("No Chromium-family binary found. Set CHROMIUM_BIN or install chromium.");
				if (
					!(await ctx.ui.confirm(
						"Launch a local browser?",
						`Binary: ${binary.path}\nAn isolated profile is created and removed afterwards. The browser is killed with the session.`,
					))
				)
					return;
				if (!ompBrowserSession) ompBrowserSession = new BrowserService({ headless: !parts.includes("--visible") });
				try {
					const targetId = await ompBrowserSession.open(url);
					ctx.ui.notify(`Opened ${url} (target ${targetId.slice(0, 8)}).`);
				} catch (error) {
					await ompBrowserSession.close();
					ompBrowserSession = undefined;
					throw error;
				}
				return;
			}
			if (action === "navigate" || action === "eval" || action === "screenshot") {
				if (!ompBrowserSession) throw new Error("No browser session. Use /xomp-browser open <url> first.");
				const targetId = parts[1];
				const rest = parts.slice(2).join(" ");
				if (action === "screenshot") {
					if (!targetId) throw new Error("Usage: /xomp-browser screenshot <target-id>");
					const data = await ompBrowserSession.screenshot(targetId);
					ctx.ui.notify(`Screenshot captured: ${data.length} base64 bytes (PNG).`);
					return;
				}
				if (!targetId || !rest)
					throw new Error(
						`Usage: /xomp-browser ${action} <target-id> <${action === "eval" ? "expression" : "url"}>`,
					);
				if (action === "navigate") {
					await ompBrowserSession.navigate(targetId, rest);
					ctx.ui.notify(`Navigated to ${rest}.`);
					return;
				}
				const value = await ompBrowserSession.evaluate(targetId, rest);
				ctx.ui.notify(`Result: ${JSON.stringify(value)}`);
				return;
			}
			if (action === "close") {
				if (!ompBrowserSession) {
					ctx.ui.notify("No browser session is running.");
					return;
				}
				await ompBrowserSession.close();
				ompBrowserSession = undefined;
				ctx.ui.notify("Browser closed and profile removed.");
				return;
			}
			throw new Error(
				"Usage: /xomp-browser [status|open <url> [--visible]|navigate <id> <url>|eval <id> <expr>|screenshot <id>|close]",
			);
		},
	});
	register("ssh", {
		description: `Manage SSH host metadata; remote execution stays with the system ssh client (${SOURCE})`,
		handler: async (args, ctx) => {
			if (!ctx.isProjectTrusted()) throw new Error("SSH host management requires a trusted project.");
			const parts = args.trim().split(/\s+/u).filter(Boolean);
			const action = parts[0] ?? "list";
			const store = new SshHostStore(join(getAgentDir(), "ssh-hosts.json"));
			if (action === "list") {
				const hosts = store.list();
				if (hosts.length === 0) {
					ctx.ui.notify("No SSH hosts stored. Use /xomp-ssh add <alias> <hostname> [user] [port].");
					return;
				}
				ctx.ui.notify(
					hosts
						.map(
							(host) =>
								`- ${host.alias}: ${host.user ? `${host.user}@` : ""}${host.hostname}:${host.port}${host.identityFile ? ` (identity: ${host.identityFile})` : ""}`,
						)
						.join("\n"),
				);
				return;
			}
			if (action === "add") {
				const alias = parts[1];
				const hostname = parts[2];
				if (!alias || !hostname) throw new Error("Usage: /xomp-ssh add <alias> <hostname> [user] [port]");
				const entry = store.add(alias, hostname, { user: parts[3], port: parts[4] ? Number(parts[4]) : undefined });
				ctx.ui.notify(
					`Stored host ${entry.alias} → ${entry.user ? `${entry.user}@` : ""}${entry.hostname}:${entry.port}.` +
						`\nMetadata only: identity keys stay at their own paths and the system ssh client handles host keys.`,
				);
				return;
			}
			if (action === "remove") {
				const alias = parts[1];
				if (!alias) throw new Error("Usage: /xomp-ssh remove <alias>");
				if (!(await ctx.ui.confirm(`Remove SSH host "${alias}"?`, "Only the stored metadata is deleted."))) return;
				ctx.ui.notify(store.remove(alias) ? `Removed host ${alias}.` : `No stored host named ${alias}.`);
				return;
			}
			if (action === "run") {
				const alias = parts[1];
				const command = parts.slice(2).join(" ");
				if (!alias || !command) throw new Error("Usage: /xomp-ssh run <alias> <command>");
				if (!ctx.hasUI)
					throw new Error("Remote command execution requires an interactive UI for per-command consent.");
				const host = store.get(alias);
				if (!host) throw new Error(`No stored host named ${alias}. Use /xomp-ssh add first.`);
				checkCommandPolicy(host, command);
				if (
					!(await ctx.ui.confirm(
						`Run on ${host.alias}?`,
						`${command}\nTarget: ${host.user ? `${host.user}@` : ""}${host.hostname}:${host.port}\nExecuted with the system ssh client in batch mode; output is capped and the command times out.`,
					))
				)
					return;
				const result = await runSshCommand(host, command);
				const status = typeof result.exitCode === "number" ? `exit ${result.exitCode}` : String(result.exitCode);
				const text = `${result.stdout}${result.stderr}`.trim() || "(no output)";
				ctx.ui.notify(
					`ssh ${host.alias}: ${status} (${Math.round(result.durationMs / 100) / 10}s${result.truncated ? ", output truncated" : ""}):\n${text.slice(0, 2000)}`,
				);
				return;
			}
			if (action === "allow" || action === "deny") {
				const alias = parts[1];
				const prefix = parts.slice(2).join(" ");
				if (!alias || !prefix) throw new Error(`Usage: /xomp-ssh ${action} <alias> <command-prefix>`);
				const host = store.get(alias);
				if (!host) throw new Error(`No stored host named ${alias}.`);
				const field = action === "allow" ? "allowedCommands" : "forbiddenCommands";
				const list = new Set(host[field] ?? []);
				list.add(prefix);
				store.update(alias, { [field]: [...list] });
				ctx.ui.notify(`${action === "allow" ? "Allowed" : "Forbidden"} prefix "${prefix}" on ${alias}.`);
				return;
			}
			if (action === "help") {
				ctx.ui.notify(
					"Usage: /xomp-ssh [list|add <alias> <hostname> [user] [port]|remove <alias>|run <alias> <command>|allow|deny|help]",
				);
				return;
			}
			throw new Error(
				"Usage: /xomp-ssh [list|add <alias> <hostname> [user] [port]|remove <alias>|run <alias> <command>|allow <alias> <prefix>|deny <alias> <prefix>|help]",
			);
		},
	});
	register("plugins", {
		description: `List, install, or remove packages through the existing package manager (${SOURCE})`,
		handler: async (args, ctx) => {
			const manager = ctx.getPackageManager?.();
			if (!manager) throw new Error("Package management is unavailable in this host.");
			const parts = args.trim().split(/\s+/u).filter(Boolean);
			const action = parts[0] ?? "list";
			if (action === "list") {
				const packages = manager.listConfiguredPackages();
				if (packages.length === 0) {
					ctx.ui.notify("No packages configured.");
					return;
				}
				const rows = packages.map((pkg) => `  [${pkg.scope}]${pkg.filtered ? " (filtered)" : ""} ${pkg.source}`);
				ctx.ui.notify(`Configured packages (${packages.length}):\n${rows.join("\n")}`);
				return;
			}
			if (action === "install" || action === "remove") {
				const source =
					parts[1] ||
					(await promptForArg(
						ctx,
						`Usage: /xomp-plugins ${action} <source> [-l]`,
						`${action === "install" ? "Install" : "Remove"} package`,
						"package source",
					));
				if (!source) return;
				const local = parts.includes("-l") || parts.includes("--local");
				if (action === "install") {
					await manager.installAndPersist(source, { local });
					ctx.ui.notify(
						`Installed ${source}${local ? " (project)" : ""} and persisted in settings. Use /reload to load it.`,
					);
				} else {
					const removed = await manager.removeAndPersist(source, { local });
					ctx.ui.notify(
						removed
							? `Removed ${source} and its settings entry.`
							: `Removed ${source}; no settings entry matched.`,
					);
				}
				return;
			}
			throw new Error("Usage: /xomp-plugins [list|install <source> [-l]|remove <source> [-l]]");
		},
	});
	register("marketplace", {
		description: `Search or install packages from the npm registry via the package manager (${SOURCE})`,
		handler: async (args, ctx) => {
			const manager = ctx.getPackageManager?.();
			if (!manager) throw new Error("Marketplace is unavailable in this host.");
			let parts = args.trim().split(/\s+/u).filter(Boolean);
			if (!parts[0] && ctx.hasUI) {
				const actionChoice = await ctx.ui.select("Marketplace", ["search", "install"]);
				if (!actionChoice) return;
				const argTitle = actionChoice === "search" ? "Search npm for" : "Package to install";
				const arg = await ctx.ui.input(argTitle, "package name or source");
				if (!arg) return;
				parts = [actionChoice, arg];
			}
			const action = parts[0];
			if (action === "search") {
				const term =
					parts.slice(1).join(" ") ||
					(await promptForArg(
						ctx,
						"Usage: /xomp-marketplace search <term>",
						"Search npm for",
						"package name or keywords",
					));
				if (!term) return;
				const run = promisify(execFile);
				const { stdout } = await run("npm", ["search", term, "--json", "--searchlimit=10"], { timeout: 30000 });
				const results = JSON.parse(stdout) as Array<{ name: string; version?: string; description?: string }>;
				if (results.length === 0) {
					ctx.ui.notify(`No npm packages match "${term}".`);
					return;
				}
				const rows = results.map(
					(pkg) =>
						`  ${pkg.name}${pkg.version ? `@${pkg.version}` : ""}${pkg.description ? ` — ${pkg.description.slice(0, 80)}` : ""}`,
				);
				ctx.ui.notify(`npm search results for "${term}":\n${rows.join("\n")}`);
				return;
			}
			if (action === "install") {
				const source =
					parts[1] ||
					(await promptForArg(
						ctx,
						"Usage: /xomp-marketplace install <source>",
						"Install package",
						"npm name or git source",
					));
				if (!source) return;
				const local = parts.includes("-l") || parts.includes("--local");
				await manager.installAndPersist(source, { local });
				ctx.ui.notify(
					`Installed ${source}${local ? " (project)" : ""}. Use /reload to load it. Installing does not grant project trust.`,
				);
			}
			throw new Error("Usage: /xomp-marketplace <search <term>|install <source> [-l]>");
		},
	});
	register("advisor", {
		description: `Manage a second-model advisor role (${SOURCE})`,
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/u).filter(Boolean);
			const action = parts[0] ?? "status";
			if (action === "on") {
				const modelId = parts[1];
				if (!modelId) throw new Error("Usage: /xomp-advisor on <model-id> [system prompt]");
				if (!ctx.hasUI) throw new Error("The advisor requires an interactive UI.");
				const systemPrompt = parts.slice(2).join(" ") || undefined;
				const modelClient = createAdvisorModelClient(ctx);
				ompAdvisorRole = new AdvisorRole({
					redactor: { redact: (text) => text },
					modelClient,
					mainTranscript: {
						recent: () =>
							ctx.sessionManager
								.getBranch()
								.filter((entry) => entry.type === "message")
								.slice(-10)
								.map((entry) => {
									const message = (entry as { message?: { role?: string; content?: unknown } }).message;
									return {
										role: message?.role ?? "user",
										content:
											typeof message?.content === "string"
												? message.content
												: JSON.stringify(message?.content ?? ""),
									};
								}),
					},
					isMainIdle: () => ctx.isIdle(),
				});
				ompAdvisorRole.enable({ model: modelId, systemPrompt, autoEngage: false });
				ctx.ui.notify(`Advisor enabled with model ${modelId}. Ask with /xomp-advisor ask <prompt>.`);
				return;
			}
			if (action === "off") {
				if (!ompAdvisorRole) {
					ctx.ui.notify("The advisor is already off.");
					return;
				}
				ompAdvisorRole.disable();
				ompAdvisorRole = undefined;
				ctx.ui.notify("Advisor disabled and its transcript dropped.");
				return;
			}
			if (action === "status") {
				if (!ompAdvisorRole) {
					ctx.ui.notify("Advisor: off.");
					return;
				}
				const config = ompAdvisorRole.getConfig();
				const usage = ompAdvisorRole.getUsage();
				ctx.ui.notify(
					`Advisor: ${ompAdvisorRole.getState()} (model ${config?.model ?? "unknown"}). ` +
						`Usage: ${usage.inputTokens} in / ${usage.outputTokens} out tokens. Transcript: ${ompAdvisorRole.getTranscript().length} message(s).`,
				);
				return;
			}
			if (action === "ask") {
				const question = parts.slice(1).join(" ");
				if (!question) throw new Error("Usage: /xomp-advisor ask <prompt>");
				if (!ompAdvisorRole) throw new Error("The advisor is off; run /xomp-advisor on <model-id> first.");
				const answer = await ompAdvisorRole.ask(question);
				ctx.ui.notify(`Advisor:\n${answer}`);
				return;
			}
			if (action === "dump") {
				if (!ompAdvisorRole) throw new Error("The advisor is off; nothing to dump.");
				const transcript = ompAdvisorRole.getTranscript();
				ctx.ui.notify(
					transcript.length === 0
						? "The advisor transcript is empty."
						: transcript.map((message) => `[${message.role}] ${message.content}`).join("\n\n"),
				);
				return;
			}
			throw new Error("Usage: /xomp-advisor [on <model-id> [prompt]|off|status|ask <prompt>|dump]");
		},
	});
	register("prewalk", {
		description: `One-shot second-model pass over an input (${SOURCE})`,
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) throw new Error("Usage: /xomp-prewalk <input>");
			if (!ctx.hasUI) throw new Error("/xomp-prewalk requires an interactive UI.");
			if (!ctx.isIdle()) throw new Error("The prewalk only runs while the main session is idle.");
			const modelId = process.env.NOUSHI_PREWALK_MODEL ?? "faux";
			const answer = await AdvisorRole.prewalk(question, {
				redactor: { redact: (text) => text },
				modelClient: createAdvisorModelClient(ctx, modelId),
				mainTranscript: { recent: () => [] },
				isMainIdle: () => true,
				config: { model: modelId, autoEngage: false },
			});
			ctx.ui.notify(`Prewalk (${modelId}):\n${answer}`);
		},
	});
	register("computer", {
		description: `Report input-automation capabilities of this session (${SOURCE})`,
		handler: async (_args, ctx) => {
			const status = detectComputerStatus();
			const lines = [`Platform: ${status.platform}`, `Session type: ${status.sessionType}`];
			if (status.tool) lines.push(`Automation tool: ${status.tool.name} (${status.tool.command})`);
			else lines.push("Automation tool: none found (xdotool/ydotool/wtype)");
			lines.push(
				status.executionSupported
					? "Execution: available with per-action consent."
					: "Execution: unavailable in this baseline. Input automation requires a reviewed per-action consent layer.",
			);
			ctx.ui.notify(lines.join("\n"));
		},
	});
	register("live", {
		description: `Report audio capture and speech-to-text capabilities (${SOURCE})`,
		handler: async (_args, ctx) => {
			const status = detectLiveStatus();
			const lines = [`Platform: ${status.platform}`, `PipeWire detected: ${status.pipewireDetected ? "yes" : "no"}`];
			lines.push(status.recorder ? `Recorder: ${status.recorder.command}` : "Recorder: pw-record not found");
			lines.push("STT provider: undecided (local whisper vs API review pending).");
			lines.push("Execution: unavailable in this baseline.");
			ctx.ui.notify(lines.join("\n"));
		},
	});
	register("collab", {
		description: `Start or stop a collaboration room over the relay (${SOURCE})`,
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/u).filter(Boolean);
			const action = parts[0] ?? "status";
			if (action === "start") {
				if (!ctx.hasUI) throw new Error("Collaboration requires an interactive UI.");
				const relayUrl = process.env.NOUSHI_COLLAB_RELAY ?? "";
				if (!relayUrl) throw new Error("Set NOUSHI_COLLAB_RELAY to a relay URL (e.g. ws://127.0.0.1:PORT).");
				const identity = loadOrCreateCollabIdentity();
				const host = new CollabHost({
					relayUrl,
					identity,
					approveJoin: async (guest) => ctx.ui.confirm("Allow guest into the room?", guest),
				});
				const invite = await host.withRelayUrl(relayUrl).start();
				ompCollabHost = host;
				ctx.ui.notify(
					`Room started: noushi://collab/${invite.roomId}\nHost fingerprint (confirm out-of-band): ${invite.hostFingerprint}`,
				);
				return;
			}
			if (action === "status") {
				if (!ompCollabHost) {
					ctx.ui.notify("No collaboration room is running.");
					return;
				}
				const status = ompCollabHost.status();
				ctx.ui.notify(
					`Room ${ompCollabHost.roomId}: ${status.members.length} member(s), ${status.events} event(s).`,
				);
				return;
			}
			if (action === "stop") {
				if (!ompCollabHost) {
					ctx.ui.notify("No collaboration room is running.");
					return;
				}
				ompCollabHost.stop();
				ompCollabHost = undefined;
				ctx.ui.notify("Room stopped.");
				return;
			}
			throw new Error("Usage: /xomp-collab [start|status|stop]");
		},
	});
	register("join", {
		description: `Join a collaboration room with an invite link (${SOURCE})`,
		handler: async (args, ctx) => {
			const link = args.trim();
			if (!link) throw new Error("Usage: /xomp-join noushi://collab/<room-id>@<host-fingerprint>");
			if (!ctx.hasUI) throw new Error("Joining a room requires an interactive UI.");
			const match = /^noushi:\/\/collab\/([A-Za-z0-9-]+)@?([0-9a-f-]*)$/u.exec(link);
			if (!match) throw new Error("Invalid invite link format.");
			const relayUrl = process.env.NOUSHI_COLLAB_RELAY ?? "";
			if (!relayUrl) throw new Error("Set NOUSHI_COLLAB_RELAY to a relay URL.");
			const identity = loadOrCreateCollabIdentity();
			const guest = new CollabGuest({
				invite: { relayUrl, roomId: match[1], hostFingerprint: match[2] },
				identity,
			});
			ompCollabGuest = guest;
			const joined = await guest.join();
			ctx.ui.notify(
				joined
					? `Joined room ${match[1]}.`
					: `The host did not grant a key for room ${match[1]} (denied or offline).`,
			);
		},
	});
	register("leave", {
		description: `Leave the current collaboration room (${SOURCE})`,
		handler: async (_args, ctx) => {
			if (!ompCollabGuest) {
				ctx.ui.notify("You are not in a collaboration room.");
				return;
			}
			ompCollabGuest.leave();
			ompCollabGuest = undefined;
			ctx.ui.notify("Left the room.");
		},
	});
}
