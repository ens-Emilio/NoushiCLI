import { readdirSync } from "node:fs";
import path from "node:path";
import { type Component, getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import { shortenHomePath } from "../../../utils/paths.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

interface Entry {
	name: string;
	isDirectory: boolean;
}

/** Browsable filesystem tree rooted at the active session working directory. */
export class FilesystemPanel implements Component {
	private readonly root: string;
	private currentPath: string;
	private entries: Entry[] = [];
	private selectedIndex = 0;
	private scrollOffset = 0;
	public onClose?: () => void;

	constructor(cwd: string) {
		this.root = path.resolve(cwd);
		this.currentPath = this.root;
		this.loadEntries();
	}

	private loadEntries(): void {
		try {
			this.entries = readdirSync(this.currentPath, { withFileTypes: true })
				.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
				.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
		} catch {
			this.entries = [];
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.entries.length - 1));
		this.scrollOffset = Math.min(this.scrollOffset, this.selectedIndex);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const kb = getKeybindings();
		const title = theme.bold(theme.fg("accent", " Files "));
		const lines = [
			new DynamicBorder().render(width)[0] ?? "",
			truncateToWidth(title, width, ""),
			new DynamicBorder().render(width)[0] ?? "",
		];
		const pathLine = theme.fg("muted", ` ${shortenHomePath(this.currentPath)}`);
		lines.push(truncateToWidth(pathLine, width, ""));
		const visibleRows = Math.max(0, (process.stdout.rows || 24) - 8);
		if (this.entries.length === 0) {
			lines.push(theme.fg("muted", "  Directory is empty or unreadable"));
		} else {
			if (this.selectedIndex < this.scrollOffset) this.scrollOffset = this.selectedIndex;
			if (this.selectedIndex >= this.scrollOffset + visibleRows)
				this.scrollOffset = this.selectedIndex - visibleRows + 1;
			for (const [offset, entry] of this.entries
				.slice(this.scrollOffset, this.scrollOffset + visibleRows)
				.entries()) {
				const index = this.scrollOffset + offset;
				const marker = entry.isDirectory ? "▸ " : "  ";
				const row = `${index === this.selectedIndex ? theme.fg("accent", ">") : " "}${marker}${entry.name}${entry.isDirectory ? "/" : ""}`;
				lines.push(truncateToWidth(index === this.selectedIndex ? theme.bold(row) : row, width, ""));
			}
		}
		lines.push(new DynamicBorder().render(width)[0] ?? "");
		lines.push(
			truncateToWidth(
				theme.fg(
					"muted",
					`${kb.getKeys("tui.select.up")[0] ?? "↑"}/${kb.getKeys("tui.select.down")[0] ?? "↓"} move · Enter open · Esc close`,
				),
				width,
				"",
			),
		);
		return lines;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "app.filesystem.toggle")) {
			this.onClose?.();
			return;
		}
		if (kb.matches(data, "tui.select.up")) this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		else if (kb.matches(data, "tui.select.down"))
			this.selectedIndex = Math.min(this.entries.length - 1, this.selectedIndex + 1);
		else if (kb.matches(data, "tui.select.confirm")) {
			const selected = this.entries[this.selectedIndex];
			if (selected?.isDirectory) {
				this.currentPath = path.join(this.currentPath, selected.name);
				this.selectedIndex = 0;
				this.scrollOffset = 0;
				this.loadEntries();
			}
		} else if (kb.matches(data, "tui.editor.cursorLeft") && this.currentPath !== this.root) {
			this.currentPath = path.dirname(this.currentPath);
			this.selectedIndex = 0;
			this.scrollOffset = 0;
			this.loadEntries();
		}
	}
}
