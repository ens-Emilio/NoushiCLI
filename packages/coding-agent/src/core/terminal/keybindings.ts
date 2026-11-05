export type EditorInputMode = "default" | "vim-insert" | "vim-normal" | "emacs";

export interface KeybindingAction {
	action:
		| "cursor-left"
		| "cursor-right"
		| "cursor-up"
		| "cursor-down"
		| "delete-char"
		| "kill-line"
		| "submit"
		| "mode-switch";
	newMode?: EditorInputMode;
}

/**
 * Resolves a key press event in Vim or Emacs mode.
 */
export function resolveEditorAction(key: string, currentMode: EditorInputMode): KeybindingAction | undefined {
	if (currentMode === "vim-normal") {
		if (key === "i") return { action: "mode-switch", newMode: "vim-insert" };
		if (key === "h") return { action: "cursor-left" };
		if (key === "l") return { action: "cursor-right" };
		if (key === "k") return { action: "cursor-up" };
		if (key === "j") return { action: "cursor-down" };
		if (key === "x") return { action: "delete-char" };
		if (key === "d") return { action: "kill-line" };
	} else if (currentMode === "vim-insert") {
		if (key === "\x1b" || key === "Escape") return { action: "mode-switch", newMode: "vim-normal" };
	} else if (currentMode === "emacs") {
		if (key === "\x01") return { action: "cursor-left" }; // Ctrl-A
		if (key === "\x05") return { action: "cursor-right" }; // Ctrl-E
		if (key === "\x0b") return { action: "kill-line" }; // Ctrl-K
	}
	return undefined;
}
