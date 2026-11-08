import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "../src/core/compaction/index.ts";
import { loadProjectContextFiles } from "../src/core/resource-loader.ts";
import { isReviewSafeShellCommand, REVIEW_ALLOWED_TOOL_NAMES } from "../src/core/security/review.ts";
import { convertExternalSessionToJsonl, detectExternalSessionFormat } from "../src/core/session-import-adapters.ts";
import { validateImportedSessionJsonl, validateSessionJsonlContent } from "../src/core/session-import-validation.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function createMessage(role: "user" | "assistant", text: string) {
	if (role === "user") {
		return { role: "user" as const, content: text, timestamp: Date.now() };
	}
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

describe("Wave5 implementation (IDs 19, 22, 23, 25, 26)", () => {
	it("ID 19: pins context entries through compaction preparation", () => {
		const session = SessionManager.inMemory();
		const _u1 = session.appendMessage(createMessage("user", "first question with some length"));
		session.appendMessage(createMessage("assistant", "first answer with details"));
		const u2 = session.appendMessage(createMessage("user", "second question with more length"));
		session.appendMessage(createMessage("assistant", "second answer"));
		const u3 = session.appendMessage(createMessage("user", "third question"));
		session.appendMessage(createMessage("assistant", "third answer"));

		const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 5 };
		const unpinnedPrep = prepareCompaction(session.getBranch(), settings, new Set());
		expect(unpinnedPrep?.firstKeptEntryId).toBe(u3);

		session.appendContextPin(u2, true);
		expect(session.getPinnedEntryIds().has(u2)).toBe(true);

		const pinnedPrep = prepareCompaction(session.getBranch(), settings, session.getPinnedEntryIds());
		expect(pinnedPrep?.firstKeptEntryId).toBe(u2);
		expect(pinnedPrep?.messagesToSummarize.length).toBeGreaterThan(0);

		session.appendContextPin(u2, false);
		expect(session.getPinnedEntryIds().has(u2)).toBe(false);
	});

	it("ID 22: validates external JSONL imports and rejects malformed/dangling content", () => {
		const tempFile = join(tmpdir(), `noushi-import-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
		try {
			writeFileSync(tempFile, "");
			expect(() => validateImportedSessionJsonl(tempFile)).toThrow(/empty/i);
			writeFileSync(tempFile, '{"type":"session","id":"s1","cwd":"/test"}\nnot-json\n');
			expect(() => validateImportedSessionJsonl(tempFile)).toThrow(/Invalid JSON/i);

			writeFileSync(tempFile, '{"type":"message","id":"m1"}\n');
			expect(() => validateImportedSessionJsonl(tempFile)).toThrow(/header/i);

			writeFileSync(
				tempFile,
				`${[
					JSON.stringify({ type: "session", id: "s1", cwd: "/test" }),
					JSON.stringify({
						type: "message",
						id: "m1",
						parentId: "unknown-parent",
						timestamp: new Date().toISOString(),
					}),
				].join("\n")}\n`,
			);
			expect(() => validateImportedSessionJsonl(tempFile)).toThrow(/Unknown parent ID/i);

			writeFileSync(
				tempFile,
				`${[
					JSON.stringify({ type: "session", id: "s1", cwd: "/test" }),
					JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString() }),
					JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: new Date().toISOString() }),
				].join("\n")}\n`,
			);
			expect(() => validateImportedSessionJsonl(tempFile)).not.toThrow();
		} finally {
			if (existsSync(tempFile)) rmSync(tempFile);
		}
	});

	it("ID 22: converts Claude Code records and detects Aider history before import", () => {
		const root = join(tmpdir(), `noushi-adapters-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const claudePath = join(root, "claude-session.jsonl");
		const aiderPath = join(root, ".aider.chat.history.md");
		try {
			writeFileSync(
				claudePath,
				`${[
					JSON.stringify({
						type: "user",
						timestamp: "2026-01-01T00:00:00.000Z",
						message: { role: "user", content: "Fix the bug" },
					}),
					JSON.stringify({
						type: "assistant",
						timestamp: "2026-01-01T00:00:01.000Z",
						message: {
							role: "assistant",
							content: [
								{ type: "text", text: "I will inspect it." },
								{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
							],
						},
					}),
				].join("\n")}\n`,
			);
			expect(detectExternalSessionFormat(claudePath)).toBe("claude-code");
			const claude = convertExternalSessionToJsonl(claudePath, "claude-code", root);
			validateSessionJsonlContent(claude, claudePath);
			expect(claude).toContain("Fix the bug");
			expect(claude).toContain("tool_use record");

			writeFileSync(aiderPath, "#### HUMAN\nFix the bug\n\n#### ASSISTANT\nI will inspect it.\n");
			expect(detectExternalSessionFormat(aiderPath)).toBe("aider");
			const aider = convertExternalSessionToJsonl(aiderPath, "aider", root);
			validateSessionJsonlContent(aider, aiderPath);
			expect(aider).toContain("Fix the bug");
			expect(aider).toContain("I will inspect it.");

			const noushiPath = join(root, "native.jsonl");
			writeFileSync(noushiPath, `${JSON.stringify({ type: "session", id: "native", cwd: root })}\n`);
			expect(detectExternalSessionFormat(noushiPath)).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("ID 23 & 25-26: loads layered project instructions and multi-root workspace folders", () => {
		const root = join(tmpdir(), `noushi-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		const extra = join(root, "extra-folder");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(project, { recursive: true });
		mkdirSync(extra, { recursive: true });

		try {
			writeFileSync(join(agentDir, "AGENTS.md"), "global rules");
			writeFileSync(join(project, "AGENTS.md"), "project rules");
			writeFileSync(join(extra, "AGENTS.md"), "extra rules");
			writeFileSync(join(project, ".noushi-workspace.json"), JSON.stringify({ folders: ["../extra-folder"] }));

			const files = loadProjectContextFiles({ cwd: project, agentDir });
			const paths = files.map((f) => f.path);
			expect(paths.some((p) => p.endsWith("agent/AGENTS.md"))).toBe(true);
			expect(paths.some((p) => p.endsWith("project/AGENTS.md"))).toBe(true);
			expect(paths.some((p) => p.endsWith("extra-folder/AGENTS.md"))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	describe("ID 24 review policy", () => {
		it("allows read-only commands and denies mutation or shell composition", () => {
			expect(REVIEW_ALLOWED_TOOL_NAMES).toEqual(["read", "grep", "find", "ls"]);
			expect(isReviewSafeShellCommand("git status --short")).toBe(true);
			expect(isReviewSafeShellCommand("rg TODO src")).toBe(true);
			expect(isReviewSafeShellCommand("git reset --hard")).toBe(false);
			expect(isReviewSafeShellCommand("cat file > out")).toBe(false);
			expect(isReviewSafeShellCommand("ls; rm -rf .")).toBe(false);
			expect(isReviewSafeShellCommand("find . -delete")).toBe(false);
			expect(isReviewSafeShellCommand("echo $(pwd)")).toBe(false);
		});
	});
});
