// Behavioral tests for the SSH host metadata store and `/xomp-ssh`: persistence,
// alias replacement, validation, trust refusal, confirmation-gated removal, and the
// explicit unavailability of remote command execution.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { SshHostStore } from "../src/core/ssh-hosts.ts";
import ompCommandsExtension from "../src/extensions/omp-commands.ts";

describe("SshHostStore", () => {
	let dir: string;
	let store: SshHostStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ssh-store-"));
		store = new SshHostStore(join(dir, "agent", "ssh-hosts.json"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("adds, lists, and persists host metadata", () => {
		store.add("prod", "prod.example.com", { user: "deploy", port: 2222, identityFile: "~/.ssh/prod_key" });
		store.add("staging", "staging.example.com");
		const reopened = new SshHostStore(join(dir, "agent", "ssh-hosts.json"));
		const hosts = reopened.list();
		expect(hosts).toHaveLength(2);
		expect(hosts[0].alias).toBe("prod");
		expect(hosts[0].port).toBe(2222);
		expect(hosts[0].identityFile).toBe("~/.ssh/prod_key");
		expect(hosts[1].port).toBe(22);
	});

	it("replaces an existing alias instead of duplicating", () => {
		store.add("prod", "old.example.com");
		store.add("prod", "new.example.com", { port: 2200 });
		expect(store.list()).toHaveLength(1);
		expect(store.get("prod")?.hostname).toBe("new.example.com");
	});

	it("rejects invalid aliases, empty hostnames, and bad ports", () => {
		expect(() => store.add("bad alias!", "host")).toThrow(/Invalid host alias/);
		expect(() => store.add("ok", "   ")).toThrow(/Hostname must not be empty/);
		expect(() => store.add("ok", "host", { port: 0 })).toThrow(/Invalid port/);
		expect(() => store.add("ok", "host", { port: 70000 })).toThrow(/Invalid port/);
	});

	it("remove reports whether anything was removed", () => {
		store.add("prod", "prod.example.com");
		expect(store.remove("prod")).toBe(true);
		expect(store.remove("prod")).toBe(false);
	});
});

describe("/xomp-ssh command", () => {
	function setup(overrides: Partial<{ trusted: boolean }> = {}) {
		const dir = mkdtempSync(join(tmpdir(), "ssh-cmd-"));
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
			cwd: dir,
			isProjectTrusted: () => overrides.trusted ?? true,
			ui: { notify, confirm },
		} as unknown as ExtensionCommandContext;
		return { dir, commands, notify, confirm, ctx };
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("add stores metadata and list shows it", async () => {
		const { commands, notify, ctx, dir } = setup();
		vi.stubEnv("NOUSHI_CODING_AGENT_DIR", join(dir, "agent"));
		await commands.get("xomp-ssh")!.handler("add prod prod.example.com deploy 2222", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("prod.example.com:2222"));
		notify.mockClear();
		await commands.get("xomp-ssh")!.handler("list", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("deploy@prod.example.com:2222"));
		vi.unstubAllEnvs();
	});

	it("list on an empty store reports the empty state", async () => {
		const { commands, notify, ctx, dir } = setup();
		vi.stubEnv("NOUSHI_CODING_AGENT_DIR", join(dir, "agent"));
		await commands.get("xomp-ssh")!.handler("list", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("No SSH hosts stored"));
		vi.unstubAllEnvs();
	});

	it("remove requires confirmation and honors refusal", async () => {
		const { commands, notify, confirm, ctx, dir } = setup();
		vi.stubEnv("NOUSHI_CODING_AGENT_DIR", join(dir, "agent"));
		await commands.get("xomp-ssh")!.handler("add prod prod.example.com", ctx);
		confirm.mockResolvedValue(false);
		await commands.get("xomp-ssh")!.handler("remove prod", ctx);
		expect(confirm).toHaveBeenCalledTimes(1);
		notify.mockClear();
		await commands.get("xomp-ssh")!.handler("list", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("prod"));
		vi.unstubAllEnvs();
	});

	it("refuses to run in an untrusted project", async () => {
		const { commands, ctx } = setup({ trusted: false });
		await expect(commands.get("xomp-ssh")!.handler("list", ctx)).rejects.toThrow(/trusted project/);
	});

	it("remote execution requires interactive UI and refuses otherwise", async () => {
		const { commands, ctx } = setup();
		await expect(commands.get("xomp-ssh")!.handler("run prod uptime", ctx)).rejects.toThrow(/interactive UI/);
	});
});
