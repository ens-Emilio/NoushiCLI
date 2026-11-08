// Behavioral tests for the durable project-scoped memory store and the `/xomp-memory`
// command family: persistence across reopen, project scoping isolation, FTS recall,
// consent gating for remember/forget, and honest empty-state output.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";
import { MemoryStore } from "../src/core/memory-store.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import ompCommandsExtension from "../src/extensions/omp-commands.ts";

describe("MemoryStore", () => {
	let dir: string;
	let store: MemoryStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "memory-store-"));
		store = new MemoryStore(join(dir, "agent", "memory.db"));
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("round-trips an entry across close and reopen", () => {
		const id = store.remember("/proj/a", "deploy script lives in scripts/deploy.sh", ["infra"]);
		store.close();
		const reopened = new MemoryStore(join(dir, "agent", "memory.db"));
		const entries = reopened.view("/proj/a");
		expect(entries).toHaveLength(1);
		expect(entries[0].id).toBe(id);
		expect(entries[0].content).toContain("deploy.sh");
		expect(entries[0].tags).toEqual(["infra"]);
		reopened.close();
	});

	it("scopes recall to the project root and never leaks across projects", () => {
		store.remember("/proj/a", "the deploy script is at scripts/deploy.sh");
		store.remember("/proj/b", "cooking recipe for bread dough");
		expect(store.recall("/proj/a", "deploy")).toHaveLength(1);
		expect(store.recall("/proj/a", "cooking")).toHaveLength(0);
		expect(store.recall("/proj/a", "cooking bread")).toHaveLength(0);
	});

	it("matches FTS terms across the content", () => {
		store.remember("/proj/a", "Tests run with npm test from the package root");
		expect(store.recall("/proj/a", "package root")).toHaveLength(1);
		expect(store.recall("/proj/a", "npm test")).toHaveLength(1);
		expect(store.recall("/proj/a", "unmatched-xyzzy")).toHaveLength(0);
	});

	it("returns most recent first on empty query and respects the limit", () => {
		for (let index = 0; index < 15; index += 1) {
			store.remember("/proj/a", `memory number ${index}`);
		}
		const recent = store.recall("/proj/a", "", 5);
		expect(recent).toHaveLength(5);
		expect(recent[0].content).toBe("memory number 14");
	});

	it("forgets by id exactly once and reports stats honestly", () => {
		const id = store.remember("/proj/a", "temporary note");
		store.remember("/proj/b", "other project");
		expect(store.forget(id)).toBe(true);
		expect(store.forget(id)).toBe(false);
		const stats = store.stats();
		expect(stats.total).toBe(1);
		expect(stats.projects).toBe(1);
	});

	it("rejects empty and oversized content", () => {
		expect(() => store.remember("/proj/a", "   ")).toThrow(/must not be empty/);
		expect(() => store.remember("/proj/a", "x".repeat(8_001))).toThrow(/8,000-character limit|8000-character limit/);
	});
});

describe("/xomp-memory command", () => {
	function setup() {
		const dir = mkdtempSync(join(tmpdir(), "memory-cmd-"));
		const commands = new Map<string, RegisteredCommand>();
		const notify = vi.fn();
		const confirm = vi.fn(async () => true);
		ompCommandsExtension({
			on: () => () => {},
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
				commands.set(name, {
					name,
					...command,
					sourceInfo: createSyntheticSourceInfo("<builtin:omp-commands>", { source: "builtin" }),
				}),
		} as unknown as ExtensionAPI);
		const ctx = {
			cwd: join(dir, "project"),
			isProjectTrusted: () => true,
			ui: { notify, confirm },
		} as unknown as ExtensionCommandContext;
		return { dir, commands, notify, confirm, ctx };
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("view on a fresh project reports the empty state honestly", async () => {
		const { commands, notify, ctx, dir } = setup();
		vi.stubEnv("NOUSHI_CODING_AGENT_DIR", join(dir, "agent"));
		await commands.get("xomp-memory")!.handler("view", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("No memories stored for this project"));
		vi.unstubAllEnvs();
	});

	it("remember requires confirmation and then stores the memory", async () => {
		const { commands, notify, confirm, ctx, dir } = setup();
		vi.stubEnv("NOUSHI_CODING_AGENT_DIR", join(dir, "agent"));
		await commands.get("xomp-memory")!.handler("remember the deploy script is scripts/deploy.sh", ctx);
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Stored memory"));
		// The entry is visible through view.
		notify.mockClear();
		await commands.get("xomp-memory")!.handler("view", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("deploy.sh"));
		vi.unstubAllEnvs();
	});

	it("remember refusal does not store anything", async () => {
		const { commands, notify, confirm, ctx, dir } = setup();
		vi.stubEnv("NOUSHI_CODING_AGENT_DIR", join(dir, "agent"));
		confirm.mockResolvedValue(false);
		await commands.get("xomp-memory")!.handler("remember secret plan", ctx);
		expect(confirm).toHaveBeenCalledTimes(1);
		notify.mockClear();
		await commands.get("xomp-memory")!.handler("view", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("No memories stored"));
		vi.unstubAllEnvs();
	});

	it("forget requires an unambiguous id and confirms before deleting", async () => {
		const { commands, notify, confirm, ctx, dir } = setup();
		vi.stubEnv("NOUSHI_CODING_AGENT_DIR", join(dir, "agent"));
		await commands.get("xomp-memory")!.handler("remember first note", ctx);
		await commands.get("xomp-memory")!.handler("remember second note", ctx);
		// Ambiguous prefix "": two memories share it.
		await expect(commands.get("xomp-memory")!.handler("forget ", ctx)).rejects.toThrow(/Usage|No memory id/);
		confirm.mockClear();
		// Grab a real id prefix via view output.
		const viewOutput = notify.mock.calls.map((call) => call[0] as string).join("\n");
		const idPrefix = /\[([0-9a-f]{8})\]/u.exec(viewOutput)?.[1];
		expect(idPrefix).toBeDefined();
		confirm.mockClear();
		notify.mockClear();
		await commands.get("xomp-memory")!.handler(`forget ${idPrefix}`, ctx);
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith("Memory forgotten.");
		vi.unstubAllEnvs();
	});

	it("stats reports totals without inventing data", async () => {
		const { commands, notify, ctx, dir } = setup();
		vi.stubEnv("NOUSHI_CODING_AGENT_DIR", join(dir, "agent"));
		await commands.get("xomp-memory")!.handler("stats", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Memories: 0 across 0 project(s)"));
		vi.unstubAllEnvs();
	});
});
