// Behavioral tests for the advisor role state machine: lifecycle transitions, redacted
// transcript projection, isolated usage metering, idle-only concurrency, and the
// one-shot prewalk. The model client is a fake; no network.

import { describe, expect, it, type Mock, vi } from "vitest";
import { type AdvisorModelClient, AdvisorRole } from "../src/core/advisor-role.ts";

interface FakeModelClient {
	client: AdvisorModelClient;
	complete: Mock;
}

function fakeClient(reply = "advisor says hi"): FakeModelClient {
	const complete = vi.fn(async () => ({ text: reply, usage: { inputTokens: 10, outputTokens: 5 } }));
	return { client: { complete }, complete };
}

function makeRole(overrides: { modelClient?: AdvisorModelClient; idle?: boolean } = {}) {
	const { client, complete } = fakeClient();
	return {
		complete,
		role: new AdvisorRole({
			redactor: { redact: (text) => text.replaceAll("sk-secret-key", "[REDACTED]") },
			modelClient: overrides.modelClient ?? client,
			mainTranscript: {
				recent: () => [
					{ role: "user", content: "my key is sk-secret-key please" },
					{ role: "assistant", content: "I will not echo it" },
				],
			},
			isMainIdle: () => overrides.idle ?? true,
		}),
	};
}

describe("AdvisorRole state machine", () => {
	it("moves off → ready on enable and back to off on disable", () => {
		const { role } = makeRole();
		expect(role.getState()).toBe("off");
		role.enable({ model: "m1", autoEngage: false });
		expect(role.getState()).toBe("ready");
		role.disable();
		expect(role.getState()).toBe("off");
		expect(role.getConfig()).toBeUndefined();
	});

	it("refuses to ask while off and while busy", async () => {
		const { role, complete } = makeRole();
		await expect(role.ask("hi")).rejects.toThrow(/advisor is off/u);
		role.enable({ model: "m1", autoEngage: false });
		let release: (() => void) | undefined;
		complete.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ text: "slow", usage: { inputTokens: 1, outputTokens: 1 } });
				}),
		);
		const pending = role.ask("first");
		await expect(role.ask("second")).rejects.toThrow(/already answering/u);
		release!();
		await expect(pending).resolves.toBe("slow");
	});

	it("refuses to ask while the main session is streaming", async () => {
		const { role } = makeRole({ idle: false });
		role.enable({ model: "m1", autoEngage: false });
		await expect(role.ask("hi")).rejects.toThrow(/main session is idle/u);
		expect(role.getState()).toBe("ready");
	});

	it("moves to error on model failure and recovers on acknowledgeError", async () => {
		const failing = fakeClient();
		failing.complete.mockRejectedValueOnce(new Error("provider down"));
		const { role } = makeRole({ modelClient: failing.client });
		role.enable({ model: "m1", autoEngage: false });
		await expect(role.ask("hi")).rejects.toThrow("provider down");
		expect(role.getState()).toBe("error");
		role.acknowledgeError();
		expect(role.getState()).toBe("ready");
	});
});

describe("advisor projection and metering", () => {
	it("projects the main transcript redacted and keeps it out of the main session", async () => {
		const { role, complete } = makeRole();
		role.enable({ model: "m1", autoEngage: false });
		await role.ask("summarize");
		const passed = complete.mock.calls[0][0] as Array<{ role: string; content: string }>;
		expect(passed.some((m) => m.content.includes("sk-secret-key"))).toBe(false);
		expect(passed.some((m) => m.content.includes("[REDACTED]"))).toBe(true);
		expect(passed[0].content.startsWith("[advisor projection]")).toBe(true);
	});

	it("accumulates usage separately per ask", async () => {
		const { role } = makeRole();
		role.enable({ model: "m1", autoEngage: false });
		await role.ask("one");
		await role.ask("two");
		expect(role.getUsage()).toEqual({ inputTokens: 20, outputTokens: 10 });
	});

	it("requires a model id to enable", () => {
		const { role } = makeRole();
		expect(() => role.enable({ model: "", autoEngage: false })).toThrow(/model id/);
	});
});

describe("prewalk", () => {
	it("answers once and disposes the role", async () => {
		const { client, complete } = fakeClient("prewalk result");
		const answer = await AdvisorRole.prewalk("what changed", {
			redactor: { redact: (t) => t },
			modelClient: client,
			mainTranscript: { recent: () => [] },
			isMainIdle: () => true,
			config: { model: "m2", autoEngage: false },
		});
		expect(answer).toBe("prewalk result");
		expect(complete).toHaveBeenCalledTimes(1);
	});
});
