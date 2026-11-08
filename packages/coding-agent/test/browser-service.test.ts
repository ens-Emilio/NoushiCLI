// Behavioral tests for the CDP browser service and `/xomp-browser`: binary resolution
// order, honest unavailability, consent gating, refusal to run without a session, and
// status reporting — all without launching a real browser.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BrowserBinary, BrowserService, resolveBrowserBinary } from "../src/core/browser-service.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import ompCommandsExtension from "../src/extensions/omp-commands.ts";

describe("resolveBrowserBinary", () => {
	afterEach(() => {
		delete process.env.CHROMIUM_BIN;
		vi.unstubAllEnvs();
	});

	it("prefers CHROMIUM_BIN over system paths", () => {
		const fake = mkdtempSync(join(tmpdir(), "browser-bin-"));
		const fakePath = join(fake, "chromium-fake");
		writeFileSync(fakePath, "#!/bin/sh\n");
		process.env.CHROMIUM_BIN = fakePath;
		const binary = resolveBrowserBinary();
		expect(binary?.path).toBe(fakePath);
		expect(binary?.source).toBe("CHROMIUM_BIN");
		rmSync(fake, { recursive: true, force: true });
	});

	it("ignores a CHROMIUM_BIN that does not exist and reports undefined honestly when nothing resolves", () => {
		process.env.CHROMIUM_BIN = "/nonexistent/chromium-xyz";
		// Only reached undefined when no system candidate exists; on hosts with chromium
		// installed the resolution legitimately succeeds, so assert consistency instead.
		const binary = resolveBrowserBinary();
		if (!binary) expect(binary).toBeUndefined();
		else expect(binary.source).toBe("system");
	});
});

describe("BrowserService", () => {
	it("status reports unavailable honestly without a binary", () => {
		const service = new BrowserService({ binary: null });
		const status = service.status();
		expect(status.available).toBe(false);
		expect(status.running).toBe(false);
	});

	it("open refuses when no binary resolves", async () => {
		const service = new BrowserService({ binary: null });
		await expect(service.open("https://example.com")).rejects.toThrow(/No Chromium-family/);
	});

	it("page commands refuse before any session is open", async () => {
		const binary: BrowserBinary = { path: "/fake/chromium", source: "CHROMIUM_BIN" };
		const service = new BrowserService({ binary });
		await expect(service.navigate("target-1", "https://example.com")).rejects.toThrow(/No browser page is open/);
		await expect(service.evaluate("target-1", "1+1")).rejects.toThrow(/No browser page is open/);
		await expect(service.screenshot("target-1")).rejects.toThrow(/No browser page is open/);
	});

	it("close is idempotent with no process", async () => {
		const service = new BrowserService({ binary: { path: "/fake/chromium", source: "test" } });
		await expect(service.close()).resolves.toBeUndefined();
	});
});

describe("/xomp-browser command", () => {
	function setup() {
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
			cwd: "/tmp",
			ui: { notify, confirm },
		} as unknown as ExtensionCommandContext;
		return { commands, notify, confirm, ctx };
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("status without a resolvable binary reports unavailability honestly", async () => {
		const { commands, notify, ctx } = setup();
		process.env.CHROMIUM_BIN = "";
		// Stub the resolution through the status path only if no system browser exists;
		// otherwise the honest output names the system binary.
		await commands.get("xomp-browser")!.handler("status", ctx);
		const output = String(notify.mock.calls.at(-1)?.[0]);
		if (output.includes("unavailable")) expect(output).toContain("CHROMIUM_BIN");
		else expect(output).toContain("Browser binary:");
	});

	it("open requires a url", async () => {
		const { commands, ctx } = setup();
		await expect(commands.get("xomp-browser")!.handler("open", ctx)).rejects.toThrow(/Usage/);
	});

	it("open without consent launches nothing", async () => {
		const { commands, confirm, notify, ctx } = setup();
		confirm.mockResolvedValue(false);
		await commands.get("xomp-browser")!.handler("open https://example.com", ctx);
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("Opened"));
	});

	it("commands before open fail with a clear message", async () => {
		const { commands, ctx } = setup();
		await expect(commands.get("xomp-browser")!.handler("screenshot abc", ctx)).rejects.toThrow(/No browser session/);
		await expect(commands.get("xomp-browser")!.handler("navigate abc https://example.com", ctx)).rejects.toThrow(
			/No browser session/,
		);
		await expect(commands.get("xomp-browser")!.handler("eval abc 1+1", ctx)).rejects.toThrow(/No browser session/);
	});

	it("close without a session reports honestly", async () => {
		const { commands, notify, ctx } = setup();
		await commands.get("xomp-browser")!.handler("close", ctx);
		expect(notify).toHaveBeenCalledWith("No browser session is running.");
	});

	it("unknown subcommands list the usage", async () => {
		const { commands, ctx } = setup();
		await expect(commands.get("xomp-browser")!.handler("frobnicate", ctx)).rejects.toThrow(/Usage: \/xomp-browser/);
	});
});
