import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";

let tempDir: string;

afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("createAgentSession built-in extension commands", () => {
	it("loads compatibility commands in default SDK sessions", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "noushi-sdk-compat-"));
		const { extensionsResult } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
		});
		const commandNames = extensionsResult.extensions.flatMap((extension) => [...extension.commands.keys()]);
		expect(commandNames).toContain("xomp-context");
		expect(commandNames).toContain("xopencode-init");
		expect(extensionsResult.runtime.getCommands()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "cl", source: "prompt" }),
				expect.objectContaining({ name: "deslop", source: "prompt" }),
				expect.objectContaining({ name: "dup", source: "prompt" }),
				expect.objectContaining({ name: "is", source: "prompt" }),
				expect.objectContaining({ name: "pr", source: "prompt" }),
				expect.objectContaining({ name: "sa", source: "prompt" }),
				expect.objectContaining({ name: "wr", source: "prompt" }),
			]),
		);
	});
});
