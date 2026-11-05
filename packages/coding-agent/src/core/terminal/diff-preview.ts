import * as Diff from "diff";

/**
 * Format a unified diff between oldContent and newContent with ANSI colors.
 */
export function formatAnsiDiff(oldPath: string, newPath: string, oldContent: string, newContent: string): string {
	const patch = Diff.createTwoFilesPatch(oldPath, newPath, oldContent, newContent, "original", "modified");
	const lines = patch.split("\n");
	return lines
		.map((line) => {
			if (line.startsWith("---") || line.startsWith("+++")) {
				return `\x1b[1m${line}\x1b[0m`; // bold
			}
			if (line.startsWith("@@")) {
				return `\x1b[36m${line}\x1b[0m`; // cyan
			}
			if (line.startsWith("+")) {
				return `\x1b[32m${line}\x1b[0m`; // green
			}
			if (line.startsWith("-")) {
				return `\x1b[31m${line}\x1b[0m`; // red
			}
			return line;
		})
		.join("\n");
}
