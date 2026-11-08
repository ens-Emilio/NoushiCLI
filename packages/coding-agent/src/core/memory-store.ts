// Durable project-scoped memory store for `/xomp-memory`: SQLite (node:sqlite) with an
// FTS5 index for deterministic recall. Scoping by project root keeps memories separate
// per project; embeddings are a deliberate non-goal at this baseline (upgrade path:
// add an embeddings column and a vector index beside the FTS table).

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface MemoryEntry {
	id: string;
	projectRoot: string;
	content: string;
	tags: string[];
	createdAt: string;
	lastSeenAt: string;
}

export interface MemoryStats {
	total: number;
	projects: number;
	oldest: string | undefined;
	newest: string | undefined;
}

const MAX_CONTENT_LENGTH = 8_000;
const DEFAULT_RECALL_LIMIT = 10;

/**
 * Open (or create) the memory database at `dbPath`. The parent directory is created on
 * demand so a fresh `~/.noushi/agent/` works without prior setup.
 */
export class MemoryStore {
	private readonly db: DatabaseSync;
	private readonly dbPath: string;
	private closed = false;
	constructor(dbPath: string) {
		this.dbPath = resolve(dbPath);
		mkdirSync(dirname(this.dbPath), { recursive: true });
		this.db = new DatabaseSync(this.dbPath);
		this.migrate();
	}

	private migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS memories (
				id TEXT PRIMARY KEY,
				project_root TEXT NOT NULL,
				content TEXT NOT NULL,
				tags TEXT NOT NULL,
				created_at TEXT NOT NULL,
				last_seen_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS memories_project ON memories(project_root);
			CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
				content,
				content='memories',
				content_rowid='rowid'
			);
			CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
				INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
			END;
			CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
				INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
			END;
			CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
				INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
				INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
			END;
		`);
	}

	private parseRow(row: Record<string, unknown>): MemoryEntry {
		return {
			id: row.id as string,
			projectRoot: row.project_root as string,
			content: row.content as string,
			tags: JSON.parse(row.tags as string) as string[],
			createdAt: row.created_at as string,
			lastSeenAt: row.last_seen_at as string,
		};
	}

	/** Store `content` for `projectRoot`, returning the new entry id. */
	remember(projectRoot: string, content: string, tags: string[] = []): string {
		const trimmed = content.trim();
		if (trimmed.length === 0) throw new Error("Memory content must not be empty.");
		if (trimmed.length > MAX_CONTENT_LENGTH)
			throw new Error(`Memory content exceeds the ${MAX_CONTENT_LENGTH}-character limit.`);
		const id = randomUUID();
		const now = new Date().toISOString();
		const tagsJson = JSON.stringify(tags);
		this.db
			.prepare(
				`INSERT INTO memories (id, project_root, content, tags, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(id, resolve(projectRoot), trimmed, tagsJson, now, now);
		return id;
	}

	/** Quote a user query into a safe FTS5 MATCH expression: each whitespace-separated
	 * term becomes a quoted phrase so operators like `-`, `AND`, `OR` match literally. */
	private quoteFtsQuery(query: string): string {
		return query
			.trim()
			.split(/\s+/u)
			.map((term) => `"${term.replaceAll(`"`, `""`)}"`)
			.join(" ");
	}

	/** Full-text search across the project's memories; empty `query` returns the most recent ones. */
	recall(projectRoot: string, query: string, limit: number = DEFAULT_RECALL_LIMIT): MemoryEntry[] {
		const root = resolve(projectRoot);
		const cap = Math.max(1, Math.min(limit, 100));
		if (query.trim().length === 0) {
			const rows = this.db
				.prepare(
					`SELECT id, project_root, content, tags, created_at, last_seen_at FROM memories
					 WHERE project_root = ? ORDER BY last_seen_at DESC, rowid DESC LIMIT ?`,
				)
				.all(root, cap) as unknown as Array<Record<string, unknown>>;
			return rows.map((row) => this.parseRow(row));
		}
		const rows = this.db
			.prepare(
				`SELECT m.id, m.project_root, m.content, m.tags, m.created_at, m.last_seen_at
				 FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
				 WHERE memories_fts MATCH ? AND m.project_root = ?
				 ORDER BY rank LIMIT ?`,
			)
			.all(this.quoteFtsQuery(query), root, cap) as unknown as Array<Record<string, unknown>>;
		return rows.map((row) => this.parseRow(row));
	}

	/** Delete a memory by id; returns whether an entry was removed. */
	forget(id: string): boolean {
		const result = this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
		return Number(result.changes) > 0;
	}

	/** Aggregate counters over the whole store. */
	stats(): MemoryStats {
		const row = this.db
			.prepare(
				`SELECT COUNT(*) AS total, COUNT(DISTINCT project_root) AS projects,
						MIN(created_at) AS oldest, MAX(created_at) AS newest FROM memories`,
			)
			.get() as { total: number; projects: number; oldest: string | null; newest: string | null };
		return {
			total: Number(row.total),
			projects: Number(row.projects),
			oldest: row.oldest ?? undefined,
			newest: row.newest ?? undefined,
		};
	}

	/** All memories for one project, oldest first. */
	view(projectRoot: string): MemoryEntry[] {
		const rows = this.db
			.prepare(
				`SELECT id, project_root, content, tags, created_at, last_seen_at FROM memories
				 WHERE project_root = ? ORDER BY created_at ASC`,
			)
			.all(resolve(projectRoot)) as unknown as Array<Record<string, unknown>>;
		return rows.map((row) => this.parseRow(row));
	}

	close(): void {
		if (!this.closed) {
			this.closed = true;
			this.db.close();
		}
	}
}

/** Default database path under the Noushi agent directory. */
export function getDefaultMemoryDbPath(agentDir: string): string {
	if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
	return resolve(agentDir, "memory.db");
}
