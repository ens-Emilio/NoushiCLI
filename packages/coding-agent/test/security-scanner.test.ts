// Behavioral tests for the local security scanner and the `/xomp-security` command:
// fixture-project scans, node_modules exclusion, SARIF golden structure, scoped file
// scans, and the command's honest usage output for unavailable subcommands.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";
import { type ScanResult, SECURITY_RULES, scanProject, toSarif } from "../src/core/security/scanner.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import ompCommandsExtension from "../src/extensions/omp-commands.ts";

const GITHUB_TOKEN = `ghp_${"a".repeat(36)}`;

describe("security scanner", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "security-scan-"));
		mkdirSync(join(dir, "src"), { recursive: true });
		mkdirSync(join(dir, "node_modules", "leaky"), { recursive: true });
		writeFileSync(join(dir, "src", "api.ts"), `const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";\nexport const ok = 1;\n`);
		writeFileSync(join(dir, "src", "tokens.ts"), `const pat = "${GITHUB_TOKEN}";\n`);
		writeFileSync(join(dir, "node_modules", "leaky", "index.ts"), `const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";\n`);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("finds known secrets with correct paths and lines", () => {
		const result = scanProject(dir);
		const aws = result.findings.find((f) => f.ruleId === "noushi.security.aws-access-key");
		expect(aws).toBeDefined();
		expect(aws!.path).toBe("src/api.ts");
		expect(aws!.line).toBe(1);
		expect(aws!.severity).toBe("error");
		const pat = result.findings.find((f) => f.ruleId === "noushi.security.github-pat");
		expect(pat).toBeDefined();
		expect(pat!.path).toBe("src/tokens.ts");
	});

	it("never enters node_modules or .noushi", () => {
		const result = scanProject(dir);
		expect(result.filesScanned).toBe(2);
		expect(result.findings.every((f) => !f.path.includes("node_modules"))).toBe(true);
	});

	it("honors a restricted file list for scoped scans", () => {
		const result = scanProject(dir, { files: [join(dir, "src", "api.ts")] });
		expect(result.filesScanned).toBe(1);
		expect(result.findings.every((f) => f.path === "src/api.ts")).toBe(true);
	});

	it("produces structurally valid SARIF 2.1.0 with rules for every finding", () => {
		const result = scanProject(dir);
		const sarif = JSON.parse(toSarif(result)) as {
			version: string;
			runs: Array<{
				tool: { driver: { rules: Array<{ id: string }> } };
				results: Array<{
					ruleId: string;
					level: string;
					locations: Array<{
						physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } };
					}>;
				}>;
			}>;
		};
		expect(sarif.version).toBe("2.1.0");
		expect(sarif.runs).toHaveLength(1);
		const run = sarif.runs[0];
		expect(run.tool.driver.rules.map((r) => r.id)).toEqual(SECURITY_RULES.map((r) => r.id));
		for (const finding of result.findings) {
			const match = run.results.find(
				(r) =>
					r.ruleId === finding.ruleId &&
					r.locations[0]?.physicalLocation.artifactLocation.uri === finding.path &&
					r.locations[0]?.physicalLocation.region.startLine === finding.line,
			);
			expect(match).toBeDefined();
		}
	});

	it("reports an empty scan honestly with zero results in SARIF", () => {
		const empty = mkdtempSync(join(tmpdir(), "security-empty-"));
		try {
			const result: ScanResult = scanProject(empty);
			expect(result.findings).toEqual([]);
			const sarif = JSON.parse(toSarif(result)) as { runs: Array<{ results: unknown[] }> };
			expect(sarif.runs[0].results).toEqual([]);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});

describe("/xomp-security command", () => {
	function setup(overrides: Partial<{ trusted: boolean }> = {}) {
		const dir = mkdtempSync(join(tmpdir(), "security-cmd-"));
		const commands = new Map<string, RegisteredCommand>();
		const notify = vi.fn();
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
			ui: { notify },
		} as unknown as ExtensionCommandContext;
		return { dir, commands, notify, ctx };
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("scan reports counts and finding rows", async () => {
		const { commands, notify, ctx, dir } = setup();
		writeFileSync(join(dir, "secret.ts"), `const key = "AKIAIOSFODNN7EXAMPLE";\n`);
		await commands.get("xomp-security")!.handler("scan", ctx);
		const output = notify.mock.calls.map((c) => c[0] as string).join("\n");
		expect(output).toContain("1 finding(s)");
		expect(output).toContain("AWS access key literal");
		expect(output).toContain("secret.ts:1");
	});

	it("export writes a parseable SARIF file", async () => {
		const { commands, notify, ctx, dir } = setup();
		writeFileSync(join(dir, "secret.ts"), `const key = "AKIAIOSFODNN7EXAMPLE";\n`);
		await commands.get("xomp-security")!.handler("export report.sarif", ctx);
		const written = JSON.parse(readFileSync(join(dir, "report.sarif"), "utf8")) as { version: string };
		expect(written.version).toBe("2.1.0");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("report.sarif"));
	});

	it("refuses to run in an untrusted project", async () => {
		const { commands, ctx } = setup({ trusted: false });
		await expect(commands.get("xomp-security")!.handler("scan", ctx)).rejects.toThrow(/trusted project/);
	});

	it("cloud subcommands fail explicitly instead of faking success", async () => {
		const { commands, ctx } = setup();
		await expect(commands.get("xomp-security")!.handler("cloud scans", ctx)).rejects.toThrow(/unavailable/);
	});
});
