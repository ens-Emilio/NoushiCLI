export interface CollapsedOutput {
	text: string;
	collapsed: boolean;
	totalLines: number;
	hiddenLines: number;
}

/**
 * Intelligently folds long command or tool outputs by keeping the first N and last M lines.
 */
export function collapseOutput(
	output: string,
	maxVisibleLines: number = 20,
	headCount: number = 5,
	tailCount: number = 5,
): CollapsedOutput {
	const lines = output.split("\n");
	const totalLines = lines.length;
	if (totalLines <= maxVisibleLines) {
		return { text: output, collapsed: false, totalLines, hiddenLines: 0 };
	}
	const head = lines.slice(0, headCount);
	const tail = lines.slice(-tailCount);
	const hiddenLines = totalLines - headCount - tailCount;
	const foldMarker = `\x1b[33m[... folded ${hiddenLines} lines ...]\x1b[0m`;
	return {
		text: [...head, foldMarker, ...tail].join("\n"),
		collapsed: true,
		totalLines,
		hiddenLines,
	};
}
