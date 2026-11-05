import { readFileSync, statSync } from "node:fs";

export function validateSessionJsonlContent(text: string, sourceLabel = "session transcript"): void {
	if (!text.trim()) throw new Error(`Session file is empty: ${sourceLabel}`);
	const lines = text.split(/\r?\n/u).filter((line) => line.trim());
	const entries: Array<{ type: string; id?: string; parentId?: string | null; timestamp?: string }> = [];
	for (let i = 0; i < lines.length; i++) {
		let value: unknown;
		try {
			value = JSON.parse(lines[i]);
		} catch {
			throw new Error(`Invalid JSON on session line ${i + 1}: ${sourceLabel}`);
		}
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			!("type" in value) ||
			typeof value.type !== "string"
		) {
			throw new Error(`Invalid session entry on line ${i + 1}: ${sourceLabel}`);
		}
		if (i === 0) {
			if (
				value.type !== "session" ||
				!("id" in value) ||
				typeof value.id !== "string" ||
				!value.id ||
				!("cwd" in value) ||
				typeof value.cwd !== "string"
			) {
				throw new Error(`Invalid session header: ${sourceLabel}`);
			}
			continue;
		}
		if (value.type === "session" || !("id" in value) || typeof value.id !== "string" || !value.id) {
			throw new Error(`Invalid session entry ID on line ${i + 1}: ${sourceLabel}`);
		}
		if (!("parentId" in value) || (value.parentId !== null && typeof value.parentId !== "string")) {
			throw new Error(`Invalid session parent on line ${i + 1}: ${sourceLabel}`);
		}
		if (!("timestamp" in value) || typeof value.timestamp !== "string" || Number.isNaN(Date.parse(value.timestamp))) {
			throw new Error(`Invalid session timestamp on line ${i + 1}: ${sourceLabel}`);
		}
		entries.push({ type: value.type, id: value.id, parentId: value.parentId, timestamp: value.timestamp });
	}
	const ids = new Set(entries.map((entry) => entry.id));
	if (ids.size !== entries.length) throw new Error(`Duplicate session entry ID: ${sourceLabel}`);
	for (let i = 0; i < entries.length; i++) {
		const parentId = entries[i].parentId;
		if (parentId != null && !ids.has(parentId)) throw new Error(`Unknown parent ID on line ${i + 2}: ${sourceLabel}`);
	}
}

export function validateImportedSessionJsonl(filePath: string): void {
	if (statSync(filePath).size === 0) throw new Error(`Session file is empty: ${filePath}`);
	validateSessionJsonlContent(readFileSync(filePath, "utf8"), filePath);
}
