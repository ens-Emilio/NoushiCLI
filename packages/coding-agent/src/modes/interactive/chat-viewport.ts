import { type Component, HStack, ScrollView, type ScrollViewScrollbar, VStack } from "@earendil-works/pi-tui";
export interface ChatViewportOptions {
	readonly document: Component;
	readonly pendingMessages: Component;
	readonly status: Component;
	readonly editor: Component;
	readonly footer: Component;
	readonly widgetsAbove?: Component;
	readonly widgetsBelow?: Component;
	readonly scrollbar?: ScrollViewScrollbar;
	readonly scrollbarTrackStyle?: (text: string) => string;
	readonly scrollbarThumbStyle?: (text: string) => string;
	readonly sidePanel?: Component;
	/** Whether the side panel should occupy its column on this render; consulted on every layout pass. */
	readonly isSidePanelVisible?: () => boolean;
}

export interface ChatViewport {
	readonly root: Component;
	readonly transcript: ScrollView;
}

/** Shared fullscreen transcript and fixed input-dock layout. */
export function createChatViewport(options: ChatViewportOptions): ChatViewport {
	const transcript = new ScrollView(options.document, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: options.scrollbar ?? "auto",
		...(options.scrollbarTrackStyle === undefined ? {} : { scrollbarTrackStyle: options.scrollbarTrackStyle }),
		...(options.scrollbarThumbStyle === undefined ? {} : { scrollbarThumbStyle: options.scrollbarThumbStyle }),
	});
	const dock = new VStack([
		{ component: options.pendingMessages, shrink: 1, minSize: 0 },
		{ component: options.status, shrink: 1, minSize: 0 },
		...(options.widgetsAbove === undefined ? [] : [{ component: options.widgetsAbove, shrink: 1, minSize: 0 }]),
		{ component: options.editor, shrink: 1, minSize: 3 },
		...(options.widgetsBelow === undefined ? [] : [{ component: options.widgetsBelow, shrink: 1, minSize: 0 }]),
		{ component: options.footer, shrink: 1, minSize: 0 },
	]);
	const chat = new VStack([
		{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	// The filesystem panel opts in per render through `visible`; an always-mounted panel would
	// reserve its column even when closed.
	const root = options.sidePanel
		? new HStack([
				{ component: chat, basis: 0, grow: 1, shrink: 1, minSize: 20 },
				{
					component: options.sidePanel,
					basis: 30,
					grow: 0,
					shrink: 1,
					minSize: 10,
					maxSize: 42,
					visible: () => options.isSidePanelVisible?.() ?? false,
				},
			])
		: chat;
	return { transcript, root };
}
