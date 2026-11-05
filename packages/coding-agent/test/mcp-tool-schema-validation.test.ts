import { describe, expect, it, vi } from "vitest";
import { createMcpToolDefinition } from "../src/extensions/mcp/tools.ts";

describe("MCP tool schema validation", () => {
	it("rejects invalid arguments before calling an MCP server", async () => {
		const callTool = vi.fn();
		const definition = createMcpToolDefinition({
			server: "docs",
			tool: {
				name: "search",
				inputSchema: {
					type: "object",
					properties: { query: { type: "string" } },
					required: ["query"],
				},
			},
			name: "mcp__docs__search",
			exposure: "direct",
			namespace: "mcp__docs",
			timeoutMs: 1000,
			getClient: async () => ({ callTool }),
		});

		await expect(definition.execute("call", {}, new AbortController().signal)).rejects.toThrow(
			'Validation failed for tool "mcp__docs__search"',
		);
		expect(callTool).not.toHaveBeenCalled();
	});

	it("rejects malformed server schemas before connecting", async () => {
		const getClient = vi.fn();
		const definition = createMcpToolDefinition({
			server: "docs",
			tool: { name: "bad", inputSchema: { $ref: "#/$defs/missing" } },
			name: "mcp__docs__bad",
			exposure: "direct",
			namespace: "mcp__docs",
			timeoutMs: 1000,
			getClient,
		});

		await expect(definition.execute("call", {}, new AbortController().signal)).rejects.toThrow();
		expect(getClient).not.toHaveBeenCalled();
	});
});
