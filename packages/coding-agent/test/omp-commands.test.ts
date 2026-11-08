import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import ompCommandsExtension, { formatContextUsage } from "../src/extensions/omp-commands.ts";

function makeContext(
	overrides: Partial<Pick<ExtensionCommandContext, "getContextUsage">> & {
		sessionManager?: { getBranch: () => SessionEntry[] };
	} = {},
) {
	const notify = vi.fn();
	return {
		notify,
		ctx: {
			getContextUsage: vi.fn(() => ({ tokens: 1250, contextWindow: 10000, percent: 12.5 })),
			hasUI: true,
			sessionManager: {
				getBranch: vi.fn(() => []),
				getSessionId: () => "session-1",
				getSessionName: () => undefined,
				getEntries: () => [],
			},
			ui: {
				notify,
				confirm: vi.fn(async () => true),
				editor: vi.fn(async (_title: string, prefill?: string) => prefill),
			},
			...overrides,
		} as unknown as ExtensionCommandContext,
	};
}

describe("OMP local commands", () => {
	it("formats current context usage and unknown context honestly", () => {
		const { ctx } = makeContext();
		expect(formatContextUsage(ctx)).toBe("Context usage: 1,250/10,000 tokens (12.5%).");
		const unknown = makeContext({ getContextUsage: () => ({ tokens: null, contextWindow: 10000, percent: null }) });
		expect(formatContextUsage(unknown.ctx)).toBe("Context usage: unknown/10,000 tokens (unknown).");
	});
	it("registers only the supported context and read-only usage operations", async () => {
		const commands = new Map<string, RegisteredCommand>();
		const sendUserMessage = vi.fn();
		ompCommandsExtension({
			on: () => () => {},
			getActiveTools: () => ["read", "bash"],
			sendUserMessage,
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
				commands.set(name, {
					name,
					...command,
					sourceInfo: createSyntheticSourceInfo("<builtin:omp-commands>", { source: "builtin" }),
				}),
		} as unknown as ExtensionAPI);
		expect([...commands.keys()]).toEqual([
			"xomp-goal",
			"goal",
			"xomp-plan",
			"plan",
			"xomp-fast",
			"fast",
			"xomp-extended-context",
			"extended-context",
			"xomp-vision",
			"vision",
			"xomp-guided-goal",
			"guided-goal",
			"xomp-vibe",
			"vibe",
			"xomp-plan-review",
			"plan-review",
			"xomp-context",
			"context",
			"xomp-session",
			"xomp-tools",
			"tools",
			"xomp-handoff",
			"handoff",
			"xomp-queue",
			"queue",
			"xomp-retry",
			"retry",
			"xomp-todo",
			"todo",
			"xomp-loop",
			"loop",
			"xomp-dirs",
			"dirs",
			"xomp-add-dir",
			"add-dir",
			"xomp-remove-dir",
			"remove-dir",
			"xomp-move",
			"move",
			"xomp-clear",
			"clear",
			"xomp-drop",
			"drop",
			"xomp-btw",
			"btw",
			"xomp-shake",
			"shake",
			"xomp-force",
			"force",
			"xomp-tan",
			"tan",
			"xomp-jobs",
			"jobs",
			"xomp-cleanse",
			"cleanse",
			"xomp-omfg",
			"omfg",
			"xomp-memory",
			"memory",
			"xomp-security",
			"security",
			"xomp-browser",
			"browser",
			"xomp-ssh",
			"ssh",
			"xomp-plugins",
			"plugins",
			"xomp-marketplace",
			"marketplace",
			"xomp-advisor",
			"advisor",
			"xomp-prewalk",
			"prewalk",
			"xomp-computer",
			"computer",
			"xomp-live",
			"live",
			"xomp-collab",
			"collab",
			"xomp-join",
			"join",
			"xomp-leave",
			"leave",
		]);
		const queue = makeContext();
		Object.assign(queue.ctx, { getQueue: () => ({ steering: ["steer this"], followUp: ["later"] }) });
		await commands.get("xomp-queue")?.handler("", queue.ctx);
		expect(queue.notify).toHaveBeenCalledWith("Steering (1):\n  steer this\nFollow-up (1):\n  later");
		const extension = commands.get("xomp-retry")!;
		const retryContext = makeContext();
		Object.assign(retryContext.ctx, { lastActivityOutcome: () => "error", lastUserPrompt: () => "try again" });
		// The extension action receives sendUserMessage from its factory API.
		await extension.handler("", retryContext.ctx);
		expect(sendUserMessage).toHaveBeenCalledWith("try again");

		const nonError = makeContext();
		await extension.handler("", nonError.ctx);
		expect(nonError.notify).toHaveBeenCalledWith("The last turn did not fail; nothing to retry.", "warning");
		sendUserMessage.mockClear();
		const loopContext = makeContext();
		Object.assign(loopContext.ctx, {
			isIdle: () => true,
			waitForIdle: vi.fn(async () => {}),
			lastActivityOutcome: () => "completed",
		});
		await commands.get("xomp-loop")!.handler("3 check status", loopContext.ctx);
		expect(sendUserMessage).toHaveBeenCalledTimes(3);
		expect(sendUserMessage).toHaveBeenLastCalledWith("check status");
		await expect(commands.get("xomp-loop")!.handler("11 check status", loopContext.ctx)).rejects.toThrow("1-10");
		const context = makeContext();
		await commands.get("xomp-session")?.handler("info", context.ctx);
		expect(context.notify).toHaveBeenCalledWith("Session: session-1\nName: unnamed\nEntries: 0");
		await commands.get("xomp-tools")?.handler("", context.ctx);
		expect(context.notify).toHaveBeenLastCalledWith("Active tools:\n  read\n  bash");

		await commands.get("xomp-context")?.handler("", context.ctx);
		expect(context.notify).toHaveBeenCalledWith("Context usage: 1,250/10,000 tokens (12.5%).");
	});

	it("persists todo additions, completes them, and rejects unknown ids", async () => {
		const commands = new Map<string, RegisteredCommand>();
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const appendEntry = (customType: string, data: unknown) => entries.push({ type: "custom", customType, data });
		ompCommandsExtension({
			on: () => () => {},
			appendEntry,
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
				commands.set(name, {
					name,
					...command,
					sourceInfo: createSyntheticSourceInfo("<builtin:omp-commands>", { source: "builtin" }),
				}),
		} as unknown as ExtensionAPI);
		const context = makeContext();
		Object.assign(context.ctx.sessionManager, { getEntries: () => entries });
		await commands.get("xomp-todo")!.handler("add review build output", context.ctx);
		expect(entries).toHaveLength(1);
		const added = entries[0]!.data as { id: string; text: string; status: string };
		expect(added).toMatchObject({ text: "review build output", status: "open" });
		await commands.get("xomp-todo")!.handler(`done ${added.id}`, context.ctx);
		await commands.get("xomp-todo")!.handler("list", context.ctx);
		expect(context.notify).toHaveBeenLastCalledWith(expect.stringContaining(`[x] ${added.id} review build output`));
		await expect(commands.get("xomp-todo")!.handler("done missing", context.ctx)).rejects.toThrow("Unknown todo id");
	});

	it("requires overwrite confirmation and validates imported todo files", async () => {
		const commands = new Map<string, RegisteredCommand>();
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const confirm = vi.fn(async () => false);
		ompCommandsExtension({
			on: () => () => {},
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
				commands.set(name, {
					name,
					...command,
					sourceInfo: createSyntheticSourceInfo("<builtin:omp-commands>", { source: "builtin" }),
				}),
		} as unknown as ExtensionAPI);
		const context = makeContext();
		const dir = mkdtempSync(join(tmpdir(), "noushi-todo-"));
		const path = join(dir, "todos.json");
		try {
			Object.assign(context.ctx, { cwd: dir, hasUI: true, isProjectTrusted: () => true });
			Object.assign(context.ctx.ui, { confirm });
			writeFileSync(path, "keep this file");
			await commands.get("xomp-todo")!.handler(`export ${path}`, context.ctx);
			expect(confirm).toHaveBeenCalledWith("Overwrite todo export?", path);
			expect(readFileSync(path, "utf8")).toBe("keep this file");
			writeFileSync(path, JSON.stringify([{ id: "", text: "bad", status: "open", createdAt: "bad" }]));
			await expect(commands.get("xomp-todo")!.handler(`import ${path}`, context.ctx)).rejects.toThrow(
				"valid todo records",
			);
			expect(entries).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("adds and removes workspace folders only in a trusted project", async () => {
		const commands = new Map<string, RegisteredCommand>();
		ompCommandsExtension({
			on: () => () => {},
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
				commands.set(name, {
					name,
					...command,
					sourceInfo: createSyntheticSourceInfo("<builtin:omp-commands>", { source: "builtin" }),
				}),
		} as unknown as ExtensionAPI);
		const cwd = mkdtempSync(join(tmpdir(), "noushi-dirs-"));
		const folder = join(cwd, "shared");
		mkdirSync(folder);
		const context = makeContext();
		const reload = vi.fn(async () => {});
		Object.assign(context.ctx, { cwd, hasUI: true, isProjectTrusted: () => true, reload });
		try {
			await commands.get("xomp-add-dir")!.handler("shared", context.ctx);
			expect(JSON.parse(readFileSync(join(cwd, ".noushi-workspace.json"), "utf8"))).toEqual({ folders: ["shared"] });
			await commands.get("xomp-remove-dir")!.handler("shared", context.ctx);
			expect(JSON.parse(readFileSync(join(cwd, ".noushi-workspace.json"), "utf8"))).toEqual({ folders: [] });
			expect(reload).toHaveBeenCalledTimes(2);
			Object.assign(context.ctx, { isProjectTrusted: () => false });
			await expect(commands.get("xomp-add-dir")!.handler("shared", context.ctx)).rejects.toThrow("trusted project");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	it("persists goals and injects active objective context", async () => {
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const commands = new Map<string, RegisteredCommand>();
		const contextHandlers: Array<(event: { messages: unknown[] }, ctx: ExtensionCommandContext) => unknown> = [];
		const costLimits: Array<number | undefined> = [];
		ompCommandsExtension({
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
			on: (event: string, handler: (event: { messages: unknown[] }, ctx: ExtensionCommandContext) => unknown) => {
				if (event === "context") contextHandlers.push(handler);
				return () => {};
			},
			setSessionCostLimit: (limit: number | undefined) => costLimits.push(limit),
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
				commands.set(name, {
					name,
					...command,
					sourceInfo: createSyntheticSourceInfo("<builtin:omp-commands>", { source: "builtin" }),
				}),
		} as unknown as ExtensionAPI);
		const context = makeContext();
		Object.assign(context.ctx.sessionManager, { getEntries: () => entries });
		await commands.get("xomp-goal")!.handler("set finish the migration", context.ctx);
		expect(entries[0]!.data).toMatchObject({ kind: "goal", status: "active", text: "finish the migration" });
		expect(costLimits).toEqual([undefined]);
		await commands.get("xomp-goal")!.handler("budget 0.5", context.ctx);
		expect(costLimits).toEqual([undefined, 0.5]);
		const originalMessage = { role: "user", content: "keep this transcript message" };
		const injected = contextHandlers[0]!({ messages: [originalMessage] }, context.ctx) as {
			messages: Array<{ customType?: string; content?: Array<{ text?: string }> } | typeof originalMessage>;
		};
		expect(injected.messages[0]).toBe(originalMessage);
		expect(injected.messages[1]).toMatchObject({ customType: "noushi.omp-objective-context" });
		expect((injected.messages[1] as { content: Array<{ text: string }> }).content[0]?.text).toContain(
			"session cost cap $0.5",
		);
		await commands.get("xomp-goal")!.handler("complete", context.ctx);
		expect(costLimits.at(-1)).toBeUndefined();
		expect(contextHandlers[0]!({ messages: [] }, context.ctx)).toBeUndefined();
	});

	it("uses read-only tools during a plan and restores the previous selection on review", async () => {
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const commands = new Map<string, RegisteredCommand>();
		let activeTools = ["read", "bash", "write"];
		ompCommandsExtension({
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
			on: () => () => {},
			getAllTools: () =>
				["read", "bash", "write", "grep", "find", "ls", "lsp", "sqlite_inspect"].map((name) => ({
					name,
					sourceInfo: createSyntheticSourceInfo(`builtin:${name}`, { source: "builtin" }),
				})),
			getActiveTools: () => activeTools,
			setActiveTools: (tools: string[]) => {
				activeTools = tools;
			},
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
				commands.set(name, {
					name,
					...command,
					sourceInfo: createSyntheticSourceInfo("<builtin:omp-commands>", { source: "builtin" }),
				}),
		} as unknown as ExtensionAPI);
		const context = makeContext();
		Object.assign(context.ctx.sessionManager, { getEntries: () => entries });
		await commands.get("xomp-plan")!.handler("inspect remaining work", context.ctx);
		expect(activeTools).toEqual(["read", "grep", "find", "ls", "lsp", "sqlite_inspect"]);
		Object.assign(context.ctx.ui, { confirm: vi.fn(async () => true) });
		await commands.get("xomp-plan-review")!.handler("", context.ctx);
		expect(activeTools).toEqual(["read", "bash", "write"]);
		expect(entries.at(-1)?.data).toMatchObject({ kind: "plan", status: "completed" });
	});

	it("maps forced tool arguments and records the confirmed call result", async () => {
		const commands = new Map<string, RegisteredCommand>();
		ompCommandsExtension({
			on: () => () => {},
			getAllTools: () => [{ name: "bash" }],
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
				commands.set(name, {
					name,
					...command,
					sourceInfo: createSyntheticSourceInfo("<builtin:omp-commands>", { source: "builtin" }),
				}),
		} as unknown as ExtensionAPI);
		const context = makeContext();
		const forceToolCall = vi.fn(async () => ({
			toolCall: { type: "toolCall" as const, id: "forced/1", name: "bash", arguments: { command: "pwd" } },
			result: { content: [{ type: "text" as const, text: "/work" }], details: {} },
			isError: false,
		}));
		Object.assign(context.ctx, { forceToolCall });
		await commands.get("xomp-force")!.handler("bash pwd", context.ctx);
		expect(forceToolCall).toHaveBeenCalledWith("bash", { command: "pwd" });
		expect(context.ctx.ui.confirm).toHaveBeenCalledWith(
			"Force bash?",
			'Arguments: {"command":"pwd"}\nThe result is recorded in the session transcript.',
		);
		expect(context.notify).toHaveBeenCalledWith("Forced bash:\n/work");
	});
	it("projects only the newest btw message for its request and omits it afterward", async () => {
		const commands = new Map<string, RegisteredCommand>();
		const projects: Array<
			(event: {
				messages: Array<{ role: string; customType?: string; content?: string | Array<unknown> }>;
			}) => unknown
		> = [];
		const sendMessage = vi.fn();
		ompCommandsExtension({
			on: (event: string, handler: unknown) => {
				if (event === "context") projects.push(handler as (typeof projects)[number]);
				return () => {};
			},
			sendMessage,
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
				commands.set(name, {
					name,
					...command,
					sourceInfo: createSyntheticSourceInfo("<builtin:omp-commands>", { source: "builtin" }),
				}),
		} as unknown as ExtensionAPI);
		const context = makeContext();
		Object.assign(context.ctx, { isIdle: () => true });
		await commands.get("xomp-btw")!.handler("what is 2+2?", context.ctx);
		expect(sendMessage).toHaveBeenCalledWith(
			{ customType: "noushi.btw", content: "what is 2+2?", display: true },
			{ triggerTurn: true },
		);
		const old = { role: "custom", customType: "noushi.btw", content: "old" };
		const latest = { role: "custom", customType: "noushi.btw", content: "new" };
		const btw = projects.find((handler) => handler({ messages: [old, latest] }) !== undefined)!;
		const projected = btw({ messages: [old, latest] }) as { messages: Array<typeof old> };
		expect(projected.messages).toEqual([
			{ ...latest, content: "[One-turn side question; answer briefly without changing the main task]\nnew" },
		]);
		const expired = btw({ messages: [old, latest, { role: "assistant" }] }) as { messages: Array<typeof old> };
		expect(expired.messages).toEqual([{ role: "assistant" }]);
	});

	it("previews image elision and appends a context edit only after confirmation", async () => {
		const commands = new Map<string, RegisteredCommand>();
		const appendContextEdit = vi.fn(() => "edit-1");
		ompCommandsExtension({
			on: () => () => {},
			appendContextEdit,
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
				commands.set(name, {
					name,
					...command,
					sourceInfo: createSyntheticSourceInfo("<builtin:omp-commands>", { source: "builtin" }),
				}),
		} as unknown as ExtensionAPI);
		const context = makeContext();
		const sourceEntry = { type: "message", id: "entry-1", message: { role: "user" } } as unknown as SessionEntry;
		Object.assign(context.ctx.sessionManager, {
			buildSessionProjection: () => ({
				entries: [
					{
						sourceEntry,
						messages: [
							{
								role: "user",
								content: [
									{ type: "text", text: "keep" },
									{ type: "image", data: "AA==", mimeType: "image/png" },
								],
							},
						],
					},
				],
			}),
		});
		const editor = vi.fn(async (_title: string, preview?: string) => preview);
		const confirm = vi.fn(async () => false);
		Object.assign(context.ctx.ui, { editor, confirm });
		await commands.get("xomp-shake")!.handler("images", context.ctx);
		expect(editor).toHaveBeenCalledWith("Preview /xomp-shake images", expect.stringContaining("entry-1"));
		expect(appendContextEdit).not.toHaveBeenCalled();
		confirm.mockResolvedValueOnce(true);
		await commands.get("xomp-shake")!.handler("images", context.ctx);
		expect(appendContextEdit).toHaveBeenCalledWith("entry-1", {
			content: [{ type: "text", text: "keep" }],
		});
		expect(context.notify).toHaveBeenLastCalledWith("Applied 1 context edit(s); transcript history was retained.");
	});

	it("refines goals with optional answers and completes vibe goal with plan review", async () => {
		const commands = new Map<string, RegisteredCommand>();
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		let activeTools = ["read", "bash", "write"];
		const inputs = ["deliverable", undefined, "do not change APIs", "run targeted checks", undefined];
		ompCommandsExtension({
			on: () => () => {},
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
			getAllTools: () =>
				["read", "bash", "write", "grep", "find", "ls", "lsp", "sqlite_inspect"].map((name) => ({
					name,
					sourceInfo: createSyntheticSourceInfo(`builtin:${name}`, { source: "builtin" }),
				})),
			getActiveTools: () => activeTools,
			setActiveTools: (tools: string[]) => {
				activeTools = tools;
			},
			setSessionCostLimit: () => {},
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
				commands.set(name, {
					name,
					...command,
					sourceInfo: createSyntheticSourceInfo("<builtin:omp-commands>", { source: "builtin" }),
				}),
		} as unknown as ExtensionAPI);
		const context = makeContext();
		Object.assign(context.ctx.sessionManager, { getEntries: () => entries });
		Object.assign(context.ctx.ui, {
			input: vi.fn(async () => inputs.shift()),
			editor: vi.fn(async (_title: string, text?: string) => text),
			confirm: vi.fn(async () => true),
		});
		await commands.get("xomp-guided-goal")!.handler("ship the tool", context.ctx);
		expect(entries[0]?.data).toMatchObject({
			kind: "goal",
			status: "active",
			text: "ship the tool\nOutcome: deliverable\nConstraints: do not change APIs\nVerification: run targeted checks",
		});

		await commands.get("xomp-vibe")!.handler("finish migration", context.ctx);
		expect(activeTools).toEqual(["read", "grep", "find", "ls", "lsp", "sqlite_inspect"]);
		expect(entries.filter((entry) => entry.customType === "noushi.vibe-session")).toHaveLength(1);
		await commands.get("xomp-plan-review")!.handler("", context.ctx);
		expect(activeTools).toEqual(["read", "bash", "write"]);
		expect(entries.filter((entry) => entry.customType === "noushi.omp-objective").at(-1)?.data).toMatchObject({
			kind: "goal",
			status: "completed",
			text: "finish migration",
		});
	});
	it("sets fast effort, filters vision images, and reports catalog context honestly", async () => {
		const commands = new Map<string, RegisteredCommand>();
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		let beforeProvider: ((event: { payload: unknown }, ctx: ExtensionCommandContext) => unknown) | undefined;
		let contextHandler: ((event: { messages: unknown[] }, ctx: ExtensionCommandContext) => unknown) | undefined;
		ompCommandsExtension({
			on: (event: string, handler: unknown) => {
				if (event === "before_provider_request") beforeProvider = handler as typeof beforeProvider;
				if (event === "context") contextHandler = handler as typeof contextHandler;
				return () => {};
			},
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
				commands.set(name, {
					name,
					...command,
					sourceInfo: createSyntheticSourceInfo("<builtin:omp-commands>", { source: "builtin" }),
				}),
		} as unknown as ExtensionAPI);
		const context = makeContext();
		Object.assign(context.ctx.sessionManager, { getEntries: () => entries });
		Object.assign(context.ctx, {
			model: { provider: "test", id: "model-1", contextWindow: 131072, input: ["text", "image"] },
		});
		await commands.get("xomp-fast")!.handler("on", context.ctx);
		expect(beforeProvider!({ payload: { reasoning: { effort: "high" } } }, context.ctx)).toEqual({
			reasoning: { effort: "low" },
		});
		await commands.get("xomp-vision")!.handler("off", context.ctx);
		const imageMessage = {
			role: "user",
			content: [
				{ type: "text", text: "keep" },
				{ type: "image", data: "AA==", mimeType: "image/png" },
			],
		};
		const projected = contextHandler!({ messages: [imageMessage] }, context.ctx) as { messages: unknown[] };
		expect(projected.messages).toEqual([{ role: "user", content: [{ type: "text", text: "keep" }] }]);
		await commands.get("xomp-extended-context")!.handler("status", context.ctx);
		expect(context.notify).toHaveBeenLastCalledWith(expect.stringMatching(/131[.,]072 tokens/));
		await expect(commands.get("xomp-extended-context")!.handler("on", context.ctx)).rejects.toThrow(
			"entitlement controls",
		);
	});

	it("starts, lists, cancels, and inspects background jobs through slash commands", async () => {
		const commands = new Map<string, RegisteredCommand>();
		ompCommandsExtension({
			on: () => () => {},
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
				commands.set(name, {
					name,
					...command,
					sourceInfo: createSyntheticSourceInfo("<builtin:omp-commands>", { source: "builtin" }),
				}),
		} as unknown as ExtensionAPI);
		const context = makeContext();
		const mockRegistry = {
			start: vi.fn(async () => "job-42"),
			list: vi.fn(() => [{ id: "job-42", label: "do work", state: "running", startedAt: "now" }]),
			cancel: vi.fn(() => true),
			resultOf: vi.fn(() => ({ state: "completed", text: "task finished successfully" })),
			waitFor: vi.fn(async () => ({ state: "completed", text: "waited result" })),
		};
		Object.assign(context.ctx, { getBackgroundJobs: () => mockRegistry });

		await commands.get("xomp-tan")!.handler("do work", context.ctx);
		expect(mockRegistry.start).toHaveBeenCalledWith("do work");
		expect(context.notify).toHaveBeenLastCalledWith(expect.stringContaining("Started background job job-42"));

		await commands.get("xomp-jobs")!.handler("list", context.ctx);
		expect(context.notify).toHaveBeenLastCalledWith(expect.stringContaining("job-42 [running] do work"));

		await commands.get("xomp-jobs")!.handler("result job-42", context.ctx);
		expect(context.notify).toHaveBeenLastCalledWith(expect.stringContaining("task finished successfully"));

		await commands.get("xomp-jobs")!.handler("cancel job-42", context.ctx);
		expect(mockRegistry.cancel).toHaveBeenCalledWith("job-42");
		expect(context.notify).toHaveBeenLastCalledWith("Cancelled background job job-42.");
	});

	it("dispatches parallel cleanse jobs from the last turn errors and persists corrections", async () => {
		const commands = new Map<string, RegisteredCommand>();
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const appendEntry = (customType: string, data: unknown) => entries.push({ type: "custom", customType, data });
		const correctionsContexts: Array<(event: { messages: unknown[] }, ctx: ExtensionCommandContext) => unknown> = [];
		ompCommandsExtension({
			on: (event: string, handler: unknown) => {
				if (event === "context") correctionsContexts.push(handler as (typeof correctionsContexts)[number]);
				return () => {};
			},
			appendEntry,
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
				commands.set(name, {
					name,
					...command,
					sourceInfo: createSyntheticSourceInfo("<builtin:omp-commands>", { source: "builtin" }),
				}),
		} as unknown as ExtensionAPI);
		const context = makeContext();
		const branch: Array<{
			type: "message";
			message: {
				role: string;
				isError?: boolean;
				toolName?: string;
				content: Array<{ type: string; text?: string }>;
			};
		}> = [
			{
				type: "message",
				message: {
					role: "toolResult",
					isError: true,
					toolName: "bash",
					content: [{ type: "text", text: "exit 1: build failed" }],
				},
			},
		];
		Object.assign(context.ctx.sessionManager, { getBranch: () => branch, getEntries: () => entries });
		const mockRegistry = {
			start: vi.fn(async () => "cleanse-1"),
			list: vi.fn(() => []),
			cancel: vi.fn(() => false),
			resultOf: vi.fn(() => undefined),
			waitFor: vi.fn(async () => ({ state: "completed", text: "" })),
		};
		Object.assign(context.ctx, { getBackgroundJobs: () => mockRegistry });
		Object.assign(context.ctx.ui, { confirm: vi.fn(async () => false) });

		await commands.get("xomp-cleanse")!.handler("", context.ctx);
		expect(mockRegistry.start).toHaveBeenCalledWith(expect.stringContaining("build failed"), { label: "cleanse:1" });

		await commands.get("xomp-omfg")!.handler("always run lint after edits", context.ctx);
		expect(entries[0]).toMatchObject({
			customType: "noushi.correction",
			data: { text: "always run lint after edits", scope: "session", status: "active" },
		});
		const image = { role: "user", content: "keep" };
		const injected = correctionsContexts[1]!({ messages: [image] }, context.ctx) as {
			messages: Array<{ customType?: string; content?: Array<{ text?: string }> }>;
		};
		expect(injected.messages.at(-1)).toMatchObject({ customType: "noushi.omp-corrections-context" });
		expect(JSON.stringify(injected.messages.at(-1))).toContain("always run lint after edits");
	});

	it("lists, installs, and removes packages through the package manager with parity", async () => {
		const commands = new Map<string, RegisteredCommand>();
		ompCommandsExtension({
			on: () => () => {},
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
				commands.set(name, {
					name,
					...command,
					sourceInfo: createSyntheticSourceInfo("<builtin:omp-commands>", { source: "builtin" }),
				}),
		} as unknown as ExtensionAPI);
		const context = makeContext();
		const mockManager = {
			listConfiguredPackages: vi.fn(() => [
				{ source: "npm:alpha", scope: "user", filtered: false, installedPath: "/root/alpha" },
				{ source: "git+https://example.com/beta", scope: "project", filtered: true },
			]),
			installAndPersist: vi.fn(async () => {}),
			removeAndPersist: vi.fn(async () => true),
		};
		Object.assign(context.ctx, { getPackageManager: () => mockManager });

		await commands.get("xomp-plugins")!.handler("list", context.ctx);
		expect(context.notify).toHaveBeenLastCalledWith(expect.stringContaining("[user] npm:alpha"));
		expect(context.notify).toHaveBeenLastCalledWith(expect.stringContaining("(filtered)"));

		await commands.get("xomp-plugins")!.handler("install npm:gamma -l", context.ctx);
		expect(mockManager.installAndPersist).toHaveBeenCalledWith("npm:gamma", { local: true });
		await commands.get("xomp-plugins")!.handler("remove npm:gamma", context.ctx);
		expect(mockManager.removeAndPersist).toHaveBeenCalledWith("npm:gamma", { local: false });

		await expect(commands.get("xomp-plugins")!.handler("bogus", context.ctx)).rejects.toThrow("Usage: /xomp-plugins");
	});
});
