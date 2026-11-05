import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";

export interface AuditLogEntry {
	timestamp: string;
	tool: string;
	resultSummary?: string;
	exitCode?: number;
	blocked?: boolean;
	reason?: string;
}

/** Return false rather than claiming an audit event was recorded when persistence fails. */
export function recordAuditLog(entry: Omit<AuditLogEntry, "timestamp">): boolean {
	try {
		const logDir = getAgentDir();
		mkdirSync(logDir, { recursive: true, mode: 0o700 });
		appendFileSync(
			join(logDir, "audit.log"),
			`${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`,
			{
				encoding: "utf-8",
				mode: 0o600,
			},
		);
		return true;
	} catch {
		return false;
	}
}
