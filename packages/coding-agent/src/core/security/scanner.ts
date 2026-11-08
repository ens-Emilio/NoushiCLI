// Local rule-based security scanner for `/xomp-security scan`: declarative regex rules
// over project files producing SARIF 2.1.0 output. Purely local; the OMP cloud family
// stays unregistered. AST analysis is a deliberate non-goal at this baseline (upgrade
// path: add acorn-based taint rules beside the regex table).

import { readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

export interface SecurityRule {
	id: string;
	name: string;
	/** Regex source; matched case-sensitively unless `caseInsensitive`. */
	pattern: string;
	caseInsensitive?: boolean;
	severity: "error" | "warning" | "note";
	description: string;
}

export interface ScanFinding {
	ruleId: string;
	ruleName: string;
	severity: "error" | "warning" | "note";
	message: string;
	path: string;
	line: number;
}

export interface ScanResult {
	/** ISO timestamp of the scan. */
	timestamp: string;
	/** Absolute project root the scan ran against. */
	projectRoot: string;
	findings: ScanFinding[];
	filesScanned: number;
}

/** File extensions the scanner inspects; everything else is skipped. */
const SCANNABLE_EXTENSIONS: Record<string, true> = {
	".ts": true,
	".tsx": true,
	".js": true,
	".jsx": true,
	".mjs": true,
	".cjs": true,
	".py": true,
	".rb": true,
	".go": true,
	".rs": true,
	".java": true,
	".sh": true,
	".bash": true,
	".env": true,
	".json": true,
	".yaml": true,
	".yml": true,
	".toml": true,
	".md": true,
};

/** Directories never entered; secrets and vendor trees are noise. */
const SKIPPED_DIRS: Record<string, true> = {
	node_modules: true,
	".git": true,
	dist: true,
	build: true,
	".noushi": true,
	target: true,
	".venv": true,
	venv: true,
	__pycache__: true,
};
const MAX_FILE_BYTES = 1_000_000;

export const SECURITY_RULES: SecurityRule[] = [
	{
		id: "noushi.security.aws-access-key",
		name: "AWS access key literal",
		pattern: "AKIA[0-9A-Z]{16}",
		severity: "error",
		description: "A literal AWS access key id is committed to the tree.",
	},
	{
		id: "noushi.security.github-pat",
		name: "GitHub personal access token",
		pattern: "gh[pousr]_[A-Za-z0-9]{30,}",
		severity: "error",
		description: "A GitHub personal access token is committed to the tree.",
	},
	{
		id: "noushi.security.openai-key",
		name: "OpenAI API key literal",
		pattern: "sk-[A-Za-z0-9_-]{20,}",
		severity: "error",
		description: "A likely OpenAI API key is committed to the tree.",
	},
	{
		id: "noushi.security.private-key-block",
		name: "Embedded private key",
		pattern: "-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
		severity: "error",
		description: "A PEM private key block is committed to the tree.",
	},
	{
		id: "noushi.security.generic-secret-assignment",
		name: "Secret-like assignment",
		pattern: "(password|passwd|secret|api[_-]?key|token)[\"'\\s]*[:=][\"'\\s]*[A-Za-z0-9+/_-]{16,}",
		caseInsensitive: true,
		severity: "warning",
		description: "An assignment looks like an inline secret; verify it is test fixture data.",
	},
	{
		id: "noushi.security.sql-concatenation",
		name: "String-concatenated SQL",
		pattern: "(SELECT|INSERT|UPDATE|DELETE)\\s.+\\+\\s*(variable|request|params|query)",
		caseInsensitive: true,
		severity: "warning",
		description: "SQL built by string concatenation suggests an injection risk.",
	},
	{
		id: "noushi.security.dynamic-eval",
		name: "Dynamic eval",
		pattern: "\\beval\\s*\\(",
		severity: "note",
		description: "eval() usage; verify the input is a compile-time constant.",
	},
];

function walkFiles(root: string, base: string = root): string[] {
	const out: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return out;
	}
	for (const entry of entries) {
		const fullPath = join(root, entry);
		let stats: Stats;
		try {
			stats = statSync(fullPath);
		} catch {
			continue;
		}
		if (stats.isDirectory()) {
			if (!SKIPPED_DIRS[entry]) out.push(...walkFiles(fullPath, base));
		} else if (stats.isFile() && stats.size <= MAX_FILE_BYTES && SCANNABLE_EXTENSIONS[extname(entry)]) {
			out.push(fullPath);
		}
	}
	return out;
}

/** Scan `projectRoot` (or a restricted file list) with the declarative rule table. */
export function scanProject(projectRoot: string, options: { files?: string[] } = {}): ScanResult {
	const root = resolve(projectRoot);
	const files = options.files ?? walkFiles(root);
	const findings: ScanFinding[] = [];
	for (const file of files) {
		let content: string;
		try {
			content = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const lines = content.split(/\r?\n/u);
		for (const rule of SECURITY_RULES) {
			const regex = new RegExp(rule.pattern, rule.caseInsensitive ? "giu" : "gu");
			for (let index = 0; index < lines.length; index += 1) {
				regex.lastIndex = 0;
				if (regex.test(lines[index])) {
					findings.push({
						ruleId: rule.id,
						ruleName: rule.name,
						severity: rule.severity,
						message: rule.description,
						path: relative(root, file),
						line: index + 1,
					});
				}
			}
		}
	}
	findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.ruleId.localeCompare(b.ruleId));
	return { timestamp: new Date().toISOString(), projectRoot: root, findings, filesScanned: files.length };
}

const SEVERITY_TO_SARIF_LEVEL: Record<ScanFinding["severity"], string> = {
	error: "error",
	warning: "warning",
	note: "note",
};

/** Render a scan result as a SARIF 2.1.0 JSON log. */
export function toSarif(result: ScanResult): string {
	return JSON.stringify({
		$schema: "https://json.schemastore.org/sarif-2.1.0.json",
		version: "2.1.0",
		runs: [
			{
				tool: {
					driver: {
						name: "Noushi security scanner",
						informationUri: "https://github.com/earendil-works/pi",
						rules: SECURITY_RULES.map((rule) => ({
							id: rule.id,
							name: rule.name,
							shortDescription: { text: rule.description },
							defaultConfiguration: { level: SEVERITY_TO_SARIF_LEVEL[rule.severity] },
						})),
					},
				},
				invocations: [
					{
						executionSuccessful: true,
						endTimeUtc: result.timestamp,
					},
				],
				results: result.findings.map((finding) => ({
					ruleId: finding.ruleId,
					level: SEVERITY_TO_SARIF_LEVEL[finding.severity],
					message: { text: `${finding.ruleName}: ${finding.message}` },
					locations: [
						{
							physicalLocation: {
								artifactLocation: { uri: finding.path },
								region: { startLine: finding.line },
							},
						},
					],
				})),
			},
		],
	});
}
/** A stable identity for a finding: rule + path + matched content. Line shifts alone
 * do not change the fingerprint; changing the flagged text does. */
export function findingFingerprint(finding: ScanFinding, sourceLine: string): string {
	const content = sourceLine.trim().replace(/\s+/gu, " ");
	return `${finding.ruleId}|${finding.path}|${content}`;
}

export interface PlanComparison {
	planId: string;
	/** Findings still present in the current scan, with their plan state. */
	unchanged: Array<{ finding: ScanFinding; fingerprint: string }>;
	/** Findings in the current scan that the plan does not list. */
	new: Array<{ finding: ScanFinding; fingerprint: string }>;
	/** Plan findings no longer present in the current scan. */
	fixed: Array<{ fingerprint: string }>;
}

interface StoredPlanFinding {
	fingerprint: string;
	ruleId: string;
	path: string;
	line: number;
	severity: string;
	message: string;
	/** The flagged source line at plan time; changed content means the finding moved. */
	sourceLine: string;
}

export interface StoredSecurityPlan {
	id: string;
	createdAt: string;
	projectRoot: string;
	findings: StoredPlanFinding[];
}
/** Read the flagged source line for a finding from its file; missing files give an empty line. */
function sourceLineFor(projectRoot: string, finding: ScanFinding): string {
	try {
		const content = readFileSync(resolve(projectRoot, finding.path), "utf8");
		return (content.split(/\r?\n/u)[finding.line - 1] ?? "").trim();
	} catch {
		return "";
	}
}

/** Create a plan from a scan: stores each finding with its content fingerprint. */
export function createPlan(planId: string, result: ScanResult): StoredSecurityPlan {
	return {
		id: planId,
		createdAt: new Date().toISOString(),
		projectRoot: result.projectRoot,
		findings: result.findings.map((finding) => ({
			fingerprint: findingFingerprint(finding, sourceLineFor(result.projectRoot, finding)),
			ruleId: finding.ruleId,
			path: finding.path,
			line: finding.line,
			severity: finding.severity,
			message: finding.message,
			sourceLine: sourceLineFor(result.projectRoot, finding),
		})),
	};
}

/** Compare a fresh scan against a stored plan: unchanged, new, and fixed findings. */
export function comparePlan(plan: StoredSecurityPlan, current: ScanResult): PlanComparison {
	const planPrints = new Map(plan.findings.map((f) => [f.fingerprint, f]));
	const unchanged: PlanComparison["unchanged"] = [];
	const fresh: PlanComparison["new"] = [];
	for (const finding of current.findings) {
		const fingerprint = findingFingerprint(finding, sourceLineFor(current.projectRoot, finding));
		if (planPrints.has(fingerprint)) unchanged.push({ finding, fingerprint });
		else fresh.push({ finding, fingerprint });
	}
	const currentPrints = new Set([...unchanged, ...fresh].map((entry) => entry.fingerprint));
	const fixed = plan.findings
		.filter((f) => !currentPrints.has(f.fingerprint))
		.map((f) => ({ fingerprint: f.fingerprint }));
	return { planId: plan.id, unchanged, new: fresh, fixed };
}

/** Load an external SARIF 2.1.0 log into a ScanResult. Rejects paths outside
 * `projectRoot` (absolute paths, `..`, drive letters) and malformed entries. */
export function importSarif(sarifJson: string, projectRoot: string): ScanResult {
	const root = resolve(projectRoot);
	const parsed: unknown = JSON.parse(sarifJson);
	if (typeof parsed !== "object" || parsed === null) throw new Error("SARIF log must be an object.");
	const version = (parsed as { version?: unknown }).version;
	if (version !== "2.1.0") throw new Error(`Unsupported SARIF version: ${String(version)}; expected 2.1.0.`);
	const runs = (parsed as { runs?: unknown }).runs;
	if (!Array.isArray(runs) || runs.length === 0) throw new Error("SARIF log has no runs.");
	const findings: ScanFinding[] = [];
	for (const run of runs) {
		const results = (run as { results?: unknown }).results;
		if (!Array.isArray(results)) continue;
		for (const result of results) {
			const record = result as { ruleId?: unknown; level?: unknown; message?: unknown; locations?: unknown };
			const ruleId = typeof record.ruleId === "string" ? record.ruleId : "external.finding";
			const severity =
				record.level === "error" || record.level === "warning" || record.level === "note" ? record.level : "note";
			const message =
				typeof (record.message as { text?: unknown })?.text === "string"
					? (record.message as { text: string }).text
					: "External SARIF finding";
			const location = Array.isArray(record.locations)
				? (record.locations[0] as Record<string, unknown> | undefined)
				: undefined;
			const physical = location?.physicalLocation as Record<string, unknown> | undefined;
			const uri =
				typeof (physical?.artifactLocation as { uri?: unknown })?.uri === "string"
					? (physical!.artifactLocation as { uri: string }).uri
					: undefined;
			const line = (physical?.region as { startLine?: unknown })?.startLine;
			if (!uri)
				throw new Error(
					"A SARIF result has no artifact location; importing findings without paths is not supported.",
				);
			const normalized = uri.replaceAll("\\\\", "/");
			if (/^[a-zA-Z]:/u.test(normalized) || normalized.startsWith("/"))
				throw new Error(`SARIF result path is outside the project: ${uri}`);
			const relativePath = normalized
				.split("/")
				.filter((segment) => segment.length > 0 && segment !== ".")
				.every((segment) => segment !== "..")
				? normalized
				: undefined;
			if (!relativePath) throw new Error(`SARIF result path escapes the project root: ${uri}`);
			findings.push({
				ruleId,
				ruleName: ruleId,
				severity,
				message,
				path: relativePath,
				line: typeof line === "number" && Number.isInteger(line) && line > 0 ? line : 1,
			});
		}
	}
	return { timestamp: new Date().toISOString(), projectRoot: root, findings, filesScanned: 0 };
}
