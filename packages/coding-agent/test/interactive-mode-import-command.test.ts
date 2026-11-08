import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionImportFileNotFoundError } from "../src/core/agent-session-runtime.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type PathCommand = "/export" | "/import";

type InteractiveModePrototype = {
	getPathCommandArgument(this: unknown, text: string, command: PathCommand): string | undefined;
	handleImportCommand(this: ImportCommandContext, text: string): Promise<void>;
};

type ImportCommandContext = {
	clearStatusIndicator: () => void;
	runtimeHost: { importFromJsonl: (inputPath: string, cwdOverride?: string) => Promise<{ cancelled: boolean }> };
	showError: (message: string) => void;
	showStatus: (message: string) => void;
	showExtensionConfirm: (title: string, message: string) => Promise<boolean>;
	handleRuntimeSessionChange: () => Promise<void>;
	renderCurrentSessionState: () => void;
	handleFatalRuntimeError: (prefix: string, error: unknown) => Promise<never>;
	promptForMissingSessionCwd: (error: unknown) => Promise<string | undefined>;
	getPathCommandArgument: (text: string, command: PathCommand) => string | undefined;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("InteractiveMode /import parsing", () => {
	it("strips quotes from /import path arguments", () => {
		expect(interactiveModePrototype.getPathCommandArgument('/import "path/to/session.jsonl"', "/import")).toBe(
			"path/to/session.jsonl",
		);
		expect(
			interactiveModePrototype.getPathCommandArgument('/import "path with spaces/session.jsonl"', "/import"),
		).toBe("path with spaces/session.jsonl");
	});

	it("preserves apostrophes in unquoted /import path arguments", () => {
		expect(interactiveModePrototype.getPathCommandArgument("/import john's/session.jsonl", "/import")).toBe(
			"john's/session.jsonl",
		);
	});

	it("enforces command token boundaries", () => {
		expect(interactiveModePrototype.getPathCommandArgument("/important /tmp/session.jsonl", "/import")).toBe(
			undefined,
		);
		expect(interactiveModePrototype.getPathCommandArgument("/exporter out.html", "/export")).toBe(undefined);
		expect(interactiveModePrototype.getPathCommandArgument("/import /tmp/session.jsonl", "/import")).toBe(
			"/tmp/session.jsonl",
		);
	});

	function createSessionFile(path: string): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-import-command-"));
		const filePath = join(dir, path);
		mkdirSync(join(filePath, ".."), { recursive: true });
		writeFileSync(filePath, "{}\n");
		return dir;
	}

	it("passes unquoted path to runtimeHost.importFromJsonl", async () => {
		const dir = createSessionFile("path/to/session.jsonl");
		const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
		const inputPath = join(dir, "path/to/session.jsonl");
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: ImportCommandContext = {
			clearStatusIndicator: vi.fn(),
			runtimeHost: { importFromJsonl },
			showError,
			showStatus,
			showExtensionConfirm,
			handleRuntimeSessionChange: vi.fn(async () => {}),
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleImportCommand.call(context, `/import "${inputPath}"`);

		expect(showExtensionConfirm).toHaveBeenCalledWith("Import session", `Replace current session with ${inputPath}?`);
		expect(importFromJsonl).toHaveBeenCalledWith(inputPath, undefined);
		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(`Session imported from: ${inputPath}`);
		rmSync(dir, { recursive: true, force: true });
	});

	it("passes unquoted apostrophe path to runtimeHost.importFromJsonl unchanged", async () => {
		const dir = createSessionFile("john's/session.jsonl");
		const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
		const inputPath = join(dir, "john's/session.jsonl");
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: ImportCommandContext = {
			clearStatusIndicator: vi.fn(),
			runtimeHost: { importFromJsonl },
			showError,
			showStatus,
			showExtensionConfirm,
			handleRuntimeSessionChange: vi.fn(async () => {}),
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleImportCommand.call(context, `/import ${inputPath}`);

		expect(importFromJsonl).toHaveBeenCalledWith(inputPath, undefined);
		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(`Session imported from: ${inputPath}`);
		rmSync(dir, { recursive: true, force: true });
	});

	it("shows a non-fatal error when /import path does not exist", async () => {
		const importFromJsonl = vi.fn(async () => {
			throw new SessionImportFileNotFoundError("/tmp/missing-session.jsonl");
		});
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();
		const handleFatalRuntimeError = vi.fn(async () => {
			throw new Error("unexpected fatal error");
		});

		const context: ImportCommandContext = {
			clearStatusIndicator: vi.fn(),
			runtimeHost: { importFromJsonl },
			showError,
			showStatus,
			showExtensionConfirm,
			handleRuntimeSessionChange: vi.fn(async () => {}),
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError,
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleImportCommand.call(context, "/import /tmp/missing-session.jsonl");

		expect(showError).toHaveBeenCalledWith("Failed to import session: File not found: /tmp/missing-session.jsonl");
		expect(showStatus).not.toHaveBeenCalled();
		expect(handleFatalRuntimeError).not.toHaveBeenCalled();
	});
});
