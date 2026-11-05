import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { validateSessionJsonlContent } from "./session-import-validation.ts";
export type ExternalSessionFormat = "claude-code" | "aider";

type ImportedMessage = {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: {
		role: "user" | "assistant";
		content: string;
		timestamp: number;
		provider: string;
		model: string;
		api: string;
		stopReason: "stop";
	};
};

function stableId(prefix: string, index: number): string {
	return `${prefix}-${index.toString(36)}-${randomUUID().slice(0, 8)}`;
}

function extractClaudeText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	const parts: string[] = [];
	for (const block of value) {
		if (!block || typeof block !== "object" || !("type" in block) || typeof block.type !== "string") continue;
		if (block.type === "text" && "text" in block && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "tool_use" || block.type === "tool_result") {
			parts.push(`[${block.type} record]\n${JSON.stringify(block)}`);
		}
	}
	return parts.join("\n");
}

function claudeMessage(
	record: unknown,
	index: number,
): { role: "user" | "assistant"; content: string; timestamp: number } | undefined {
	if (!record || typeof record !== "object" || !("type" in record) || typeof record.type !== "string")
		return undefined;
	const item = record as {
		type: string;
		timestamp?: unknown;
		message?: unknown;
		content?: unknown;
		isSidechain?: unknown;
	};
	if (item.isSidechain === true || (item.type !== "user" && item.type !== "assistant")) return undefined;
	const msg =
		item.message && typeof item.message === "object"
			? (item.message as { content?: unknown; role?: unknown })
			: undefined;
	const content = extractClaudeText(msg?.content ?? item.content);
	if (!content) return undefined;
	const parsedTime = typeof item.timestamp === "string" ? Date.parse(item.timestamp) : Number.NaN;
	return {
		role: item.type === "user" ? "user" : "assistant",
		content,
		timestamp: Number.isFinite(parsedTime) ? parsedTime : index + 1,
	};
}

function parseClaudeCode(text: string, cwd: string): string {
	const lines = text.split(/\r?\n/u).filter((line) => line.trim());
	if (!lines.length) throw new Error("Claude Code transcript is empty");
	const records: unknown[] = [];
	for (let i = 0; i < lines.length; i++) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(lines[i]);
		} catch {
			throw new Error(`Invalid Claude Code JSONL on line ${i + 1}`);
		}
		if (!parsed || typeof parsed !== "object" || !("type" in parsed) || typeof parsed.type !== "string") {
			throw new Error(`Invalid Claude Code record on line ${i + 1}`);
		}
		records.push(parsed);
	}
	const result: unknown[] = [
		{ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd },
	];
	let parentId: string | null = null;
	let index = 0;
	for (const record of records) {
		const message = claudeMessage(record, index);
		if (!message) continue;
		const id = stableId("claude", index++);
		const entry: ImportedMessage = {
			type: "message",
			id,
			parentId,
			timestamp: new Date(message.timestamp).toISOString(),
			message: {
				...message,
				provider: "external-claude-code",
				model: "imported",
				api: "external-transcript",
				stopReason: "stop",
			},
		};
		result.push(entry);
		parentId = id;
	}
	if (index === 0) throw new Error("Claude Code transcript contains no user or assistant text");
	return `${result.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function parseAider(text: string, cwd: string): string {
	const chunks = text.split(/^(?:####\s*(USER|HUMAN|ASSISTANT)\s*\r?\n)/gimu);
	const result: unknown[] = [
		{ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd },
	];
	let parentId: string | null = null;
	let index = 0;
	for (let i = 1; i + 1 < chunks.length; i += 2) {
		const roleLabel = chunks[i].toLowerCase();
		const content = chunks[i + 1].trim();
		if (!content) continue;
		const id = stableId("aider", index++);
		const timestamp = new Date(index).toISOString();
		const message: ImportedMessage = {
			type: "message",
			id,
			parentId,
			timestamp,
			message: {
				role: roleLabel === "user" || roleLabel === "human" ? "user" : "assistant",
				content,
				timestamp: index,
				provider: "external-aider",
				model: "imported",
				api: "external-transcript",
				stopReason: "stop",
			},
		};
		result.push(message);
		parentId = id;
	}
	if (index === 0) throw new Error("Aider transcript has no recognized #### USER/HUMAN/ASSISTANT sections");
	return `${result.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

export function detectExternalSessionFormat(filePath: string): ExternalSessionFormat | undefined {
	const name = basename(filePath).toLowerCase();
	if (name.endsWith(".aider.chat.history.md") || name.endsWith(".aider.md")) return "aider";
	if (name.endsWith(".jsonl") || name.endsWith(".json")) {
		const firstLine = readFileSync(filePath, "utf8")
			.split(/\r?\n/u)
			.find((line) => line.trim());
		if (!firstLine) return undefined;
		try {
			const first = JSON.parse(firstLine);
			if (!first || typeof first !== "object" || !("type" in first)) return undefined;
			return first.type === "user" || first.type === "assistant" ? "claude-code" : undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/** Convert a validated Claude Code or Aider transcript into Noushi JSONL before destination writes. */
export function convertExternalSessionToJsonl(
	filePath: string,
	format: ExternalSessionFormat,
	cwd = process.cwd(),
): string {
	const source = readFileSync(filePath, "utf8");
	const converted = format === "claude-code" ? parseClaudeCode(source, cwd) : parseAider(source, cwd);
	validateSessionJsonlContent(converted, filePath);
	return converted;
}
