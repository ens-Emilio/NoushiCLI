import { describe, expect, it } from "vitest";
import { compactOldToolResults } from "../src/core/messages.ts";

describe("compactOldToolResults", () => {
	it("compacts only old large tool results", () => {
		const results = Array.from({ length: 9 }, (_, index) => ({
			role: "toolResult" as const,
			toolCallId: `call-${index}`,
			toolName: "read",
			content: [{ type: "text" as const, text: "x".repeat(700) }],
			isError: false,
			timestamp: index,
		}));
		const compacted = compactOldToolResults(results);
		expect(
			compacted[0]?.role === "toolResult" &&
				compacted[0].content[0]?.type === "text" &&
				compacted[0].content[0].text,
		).toContain("older tool result compacted");
		expect(compacted.at(-1)).toEqual(results.at(-1));
	});
});
