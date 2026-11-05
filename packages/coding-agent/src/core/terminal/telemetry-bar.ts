export interface TelemetryBarState {
	model: string;
	contextTokens: number;
	maxTokens?: number;
	totalCostUsd?: number;
	activeTool?: string;
}

/**
 * Format a real-time telemetry status line for the bottom of the terminal.
 */
export function formatTelemetryBar(state: TelemetryBarState): string {
	const parts: string[] = [];
	parts.push(`\x1b[1m[${state.model}]\x1b[0m`);

	if (state.maxTokens && state.maxTokens > 0) {
		const pct = Math.round((state.contextTokens / state.maxTokens) * 100);
		parts.push(
			`ctx: ${state.contextTokens.toLocaleString("en-US")}/${state.maxTokens.toLocaleString("en-US")} (${pct}%)`,
		);
	} else {
		parts.push(`ctx: ${state.contextTokens.toLocaleString("en-US")}`);
	}

	if (typeof state.totalCostUsd === "number") {
		parts.push(`cost: $${state.totalCostUsd.toFixed(4)}`);
	}

	if (state.activeTool) {
		parts.push(`\x1b[32mtool: ${state.activeTool}\x1b[0m`);
	}

	return parts.join(" | ");
}
