// Behavioral tests for the security plan lifecycle: create a plan from a scan, keep
// fingerprints stable across line shifts, import external SARIF with path confinement,
// and report unchanged/new/fixed comparisons honestly.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	comparePlan,
	createPlan,
	findingFingerprint,
	importSarif,
	type StoredSecurityPlan,
	scanProject,
	toSarif,
} from "../src/core/security/scanner.ts";

const AWS_LINE = `const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";`;

describe("security plan lifecycle", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "security-plan-"));
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "api.ts"), `${AWS_LINE}\nexport const ok = 1;\n`);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("creates a plan with fingerprints and compares an unchanged tree", () => {
		const plan = createPlan("p1", scanProject(dir));
		expect(plan.findings).toHaveLength(1);
		const comparison = comparePlan(plan, scanProject(dir));
		expect(comparison.unchanged).toHaveLength(1);
		expect(comparison.new).toHaveLength(0);
		expect(comparison.fixed).toHaveLength(0);
	});

	it("treats a pure line shift as unchanged when content matches", () => {
		const plan = createPlan("p1", scanProject(dir));
		// Insert a comment above the secret; the finding moves but content stays.
		writeFileSync(join(dir, "src", "api.ts"), `// new comment\n${AWS_LINE}\nexport const ok = 1;\n`);
		const comparison = comparePlan(plan, scanProject(dir));
		expect(comparison.unchanged).toHaveLength(1);
		expect(comparison.fixed).toHaveLength(0);
	});

	it("reports fixed when the secret is removed and new when one is added", () => {
		const plan = createPlan("p1", scanProject(dir));
		writeFileSync(join(dir, "src", "api.ts"), `export const clean = true;\n`);
		let comparison = comparePlan(plan, scanProject(dir));
		expect(comparison.fixed).toHaveLength(1);
		expect(comparison.unchanged).toHaveLength(0);
		writeFileSync(join(dir, "src", "other.ts"), `const token = "ghp_${"b".repeat(36)}";\n`);
		comparison = comparePlan(plan, scanProject(dir));
		expect(comparison.new).toHaveLength(2);
	});

	it("fingerprints differ when the flagged content changes", () => {
		const base = { ruleId: "r", ruleName: "R", severity: "error" as const, message: "m", path: "a.ts", line: 1 };
		const first = findingFingerprint(base, `const KEY = "one";`);
		const second = findingFingerprint({ ...base, line: 5 }, `const KEY = "two";`);
		const sameLine = findingFingerprint({ ...base, line: 5 }, `const KEY = "one";`);
		expect(first).not.toBe(second);
		expect(first).toBe(sameLine);
	});
});

describe("SARIF import", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sarif-import-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("round-trips our own SARIF output into equivalent findings", () => {
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "api.ts"), `${AWS_LINE}\n`);
		const scan = scanProject(dir);
		const imported = importSarif(toSarif(scan), dir);
		expect(imported.findings).toHaveLength(scan.findings.length);
		for (const finding of scan.findings) {
			const match = imported.findings.find(
				(f) => f.ruleId === finding.ruleId && f.path === finding.path && f.line === finding.line,
			);
			expect(match).toBeDefined();
		}
	});

	it("accepts relative paths and rejects absolute and escaping paths", () => {
		const sarif = (uri: string) =>
			JSON.stringify({
				version: "2.1.0",
				runs: [
					{
						tool: { driver: { name: "x" } },
						results: [
							{
								ruleId: "ext.rule",
								level: "warning",
								message: { text: "test" },
								locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: 3 } } }],
							},
						],
					},
				],
			});
		expect(() => importSarif(sarif("C:\\secrets\\k.txt"), dir)).toThrow(/outside the project/);
		// The parent-escape check throws its own clear error.
		try {
			importSarif(sarif("../outside.ts"), dir);
			expect.unreachable("importing an escaping path must throw");
		} catch (error) {
			expect((error as Error).message).toContain("escapes the project root");
		}
	});

	it("rejects wrong SARIF versions and empty logs", () => {
		expect(() => importSarif(JSON.stringify({ version: "2.0.0", runs: [] }), dir)).toThrow(/2\.1\.0/);
		expect(() => importSarif(JSON.stringify({ version: "2.1.0" }), dir)).toThrow(/no runs/);
		expect(() => importSarif("not json", dir)).toThrow();
	});
});

describe("stored plan JSON round trip", () => {
	it("survives a JSON serialize/parse cycle and compares correctly", () => {
		const dir = mkdtempSync(join(tmpdir(), "plan-json-"));
		try {
			mkdirSync(join(dir, "src"));
			writeFileSync(join(dir, "src", "api.ts"), `${AWS_LINE}\n`);
			const plan: StoredSecurityPlan = JSON.parse(JSON.stringify(createPlan("p9", scanProject(dir))));
			const comparison = comparePlan(plan, scanProject(dir));
			expect(comparison.unchanged).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
