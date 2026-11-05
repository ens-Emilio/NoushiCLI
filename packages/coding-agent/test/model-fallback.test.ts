import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { selectFallbackModel } from "../src/core/model-fallback.ts";

const model = (id: string) => ({ id }) as Model<any>;
const failed = (errorMessage: string) => ({ stopReason: "error", errorMessage }) as AssistantMessage;

describe("selectFallbackModel", () => {
	it("uses the fallback only for classified retryable failures", () => {
		const primary = model("primary");
		const fallback = model("fallback");
		const policy = { fallback };
		expect(selectFallbackModel(primary, failed("503 service unavailable"), policy)).toBe(fallback);
		expect(selectFallbackModel(primary, failed("invalid_api_key"), policy)).toBe(primary);
		expect(selectFallbackModel(primary, failed("503 service unavailable"))).toBe(primary);
	});
});
