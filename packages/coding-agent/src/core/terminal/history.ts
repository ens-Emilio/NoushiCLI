import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** In-memory prompt history with reverse substring search. */
export class PromptHistory {
	private readonly maxEntries = 500;
	private historyPath?: string;

	constructor(historyPath?: string) {
		this.historyPath = historyPath;
		if (!historyPath) return;
		try {
			const value: unknown = JSON.parse(readFileSync(historyPath, "utf8"));
			if (Array.isArray(value)) {
				for (const entry of value) if (typeof entry === "string") this.add(entry, false);
			}
		} catch {
			// Missing or invalid history starts empty.
		}
	}
	private readonly entries: string[] = [];
	private cursor = 0;

	add(prompt: string, persist = true): void {
		const value = prompt.trim();
		if (!value || this.entries.at(-1) === value) return;
		this.entries.push(value);
		if (this.entries.length > this.maxEntries) this.entries.shift();
		this.cursor = this.entries.length;
		if (persist) this.save();
	}

	search(query: string, from: number = this.entries.length): { text: string; index: number } | undefined {
		const normalized = query.toLowerCase();
		for (let index = Math.min(from - 1, this.entries.length - 1); index >= 0; index--) {
			if (this.entries[index].toLowerCase().includes(normalized)) return { text: this.entries[index], index };
		}
		return undefined;
	}

	previous(): string | undefined {
		if (this.entries.length === 0) return undefined;
		this.cursor = Math.max(0, this.cursor - 1);
		return this.entries[this.cursor];
	}

	next(): string | undefined {
		if (this.entries.length === 0) return undefined;
		this.cursor = Math.min(this.entries.length, this.cursor + 1);
		return this.entries[this.cursor];
	}

	toArray(): readonly string[] {
		return this.entries;
	}
	private save(): void {
		if (!this.historyPath) return;
		try {
			mkdirSync(dirname(this.historyPath), { recursive: true, mode: 0o700 });
			writeFileSync(this.historyPath, `${JSON.stringify(this.entries)}\n`, { mode: 0o600 });
		} catch {
			// History is best-effort and must not interrupt prompt entry.
		}
	}
}
