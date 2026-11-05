import {
	Editor,
	type EditorOptions,
	type EditorTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import type { StatusIndicator } from "./status-indicator.ts";

export type CustomEditorOptions = EditorOptions & {
	/** Render working, compaction, summarization, and retry status in the editor's top border. */
	embedWorkingStatus?: boolean;
};

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private workingStatusIndicator: StatusIndicator | undefined;
	public readonly embedWorkingStatus: boolean;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;
	public onHistorySearch?: (query: string, from?: number) => { text: string; index: number } | undefined;
	public onHistoryAdded?: (text: string) => void;
	public vimMode = false;
	private vimNormalMode = false;
	private historySearchQuery?: string;
	private historySearchFrom?: number;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
		this.embedWorkingStatus = options?.embedWorkingStatus ?? false;
	}

	setVimMode(enabled: boolean): void {
		this.vimMode = enabled;
		this.vimNormalMode = false;
		this.tui.requestRender();
	}

	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void {
		this.workingStatusIndicator = indicator;
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		const border = this.renderBaseTopBorder(width, hiddenLineCount);
		if (!this.vimMode || width < 10) return border;
		const label = this.vimNormalMode ? " NORMAL " : " INSERT ";
		return truncateToWidth(border, Math.max(0, width - visibleWidth(label)), "") + "\x1b[0m" + label;
	}

	private renderBaseTopBorder(width: number, hiddenLineCount: number): string {
		if (!this.embedWorkingStatus || !this.workingStatusIndicator || width <= 0) {
			return super.renderTopBorder(width, hiddenLineCount);
		}
		let status = this.workingStatusIndicator.renderInBorder(Math.max(1, width - 5));
		let statusWidth = visibleWidth(status);
		if (statusWidth === 0) return super.renderTopBorder(width, hiddenLineCount);

		const overflowLabel = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : undefined;
		const overflowLabelWidth = overflowLabel ? visibleWidth(overflowLabel) : 0;
		const overflowStart = Math.floor((width - overflowLabelWidth) / 2);
		const canFitOverflow = () =>
			overflowLabel !== undefined && overflowLabelWidth + 2 <= width && overflowStart - (3 + statusWidth + 1) >= 1;

		if (overflowLabel && !canFitOverflow()) {
			status = this.workingStatusIndicator.renderSpinnerInBorder(width);
			statusWidth = visibleWidth(status);
		}

		if (canFitOverflow()) {
			const leftBlockWidth = 3 + statusWidth + 1;
			return (
				this.borderColor("── ") +
				status +
				this.borderColor(
					` ${"─".repeat(overflowStart - leftBlockWidth)}${overflowLabel}${"─".repeat(width - overflowStart - overflowLabelWidth)}`,
				)
			);
		}

		if (width >= statusWidth + 5) {
			return this.borderColor("── ") + status + this.borderColor(` ${"─".repeat(width - statusWidth - 4)}`);
		}

		status = this.workingStatusIndicator.renderSpinnerInBorder(width);
		statusWidth = visibleWidth(status);
		const prefixWidth = Math.min(3, Math.max(0, width - statusWidth));
		return (
			this.borderColor("─".repeat(prefixWidth)) +
			status +
			this.borderColor("─".repeat(Math.max(0, width - prefixWidth - statusWidth)))
		);
	}
	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}
	searchHistory(query: string): string | undefined {
		if (this.historySearchQuery === undefined) {
			this.historySearchQuery = query;
			this.historySearchFrom = undefined;
		}
		const result = this.onHistorySearch?.(this.historySearchQuery, this.historySearchFrom);
		if (result) this.historySearchFrom = result.index;
		return result?.text;
	}

	override addToHistory(text: string): void {
		super.addToHistory(text);
		this.onHistoryAdded?.(text.trim());
	}

	handleInput(data: string): void {
		if (!this.keybindings.matches(data, "app.editor.searchHistory")) {
			this.historySearchQuery = undefined;
			this.historySearchFrom = undefined;
		}
		if (this.keybindings.matches(data, "app.editor.vimMode")) {
			this.setVimMode(!this.vimMode);
			return;
		}
		if (this.vimMode && !this.isShowingAutocomplete()) {
			if (this.vimNormalMode) {
				if (data === "i") this.vimNormalMode = false;
				else if (data === "a") {
					super.handleInput("\x1b[C");
					this.vimNormalMode = false;
				} else if (data === "h") super.handleInput("\x1b[D");
				else if (data === "j") super.handleInput("\x1b[B");
				else if (data === "k") super.handleInput("\x1b[A");
				else if (data === "l") super.handleInput("\x1b[C");
				else if (data === "0") super.handleInput("\x01");
				else if (data === "$") super.handleInput("\x05");
				else if (data.length === 1) return;
				this.tui.requestRender();
				return;
			} else if (data === "\x1b") {
				this.vimNormalMode = true;
				this.tui.requestRender();
				return;
			}
		}
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Selection page keys move an open autocomplete menu before app actions run.
		// This lets users bind Ctrl+V even though it pastes images by default.
		if (
			this.isShowingAutocomplete() &&
			(this.keybindings.matches(data, "tui.select.pageUp") || this.keybindings.matches(data, "tui.select.pageDown"))
		) {
			super.handleInput(data);
			return;
		}

		// Check for clipboard paste keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return;
		}

		if (this.keybindings.matches(data, "app.editor.searchHistory")) {
			const result = this.searchHistory(this.getText());
			if (result !== undefined) this.setText(result);
			return;
		}
		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
