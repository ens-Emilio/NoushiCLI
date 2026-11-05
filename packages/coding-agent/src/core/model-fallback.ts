import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";

export interface ModelFallbackPolicy {
	fallback: Model<any>;
}

export function selectFallbackModel(
	primary: Model<any>,
	failed: AssistantMessage | undefined,
	policy?: ModelFallbackPolicy,
): Model<any> {
	if (!policy || !failed || !isRetryableAssistantError(failed)) return primary;
	return policy.fallback;
}
