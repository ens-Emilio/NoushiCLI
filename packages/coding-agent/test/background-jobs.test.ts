import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { BackgroundJobRegistry } from "../src/core/background-jobs.ts";

describe("BackgroundJobRegistry", () => {
	let registry: BackgroundJobRegistry;
	const activeSessions: AgentSession[] = [];
	function fakeSession(reply = "done", holdUntil?: Promise<void>): AgentSession {
		let aborted = false;
		const messages: Array<{ role: string; content: string }> = [];
		const session = {
			messages,
			prompt: async (_text: string) => {
				if (holdUntil) await holdUntil;
				if (!aborted) messages.push({ role: "assistant", content: reply });
			},
			abort: () => {
				aborted = true;
			},
		} as unknown as AgentSession;
		activeSessions.push(session);
		return session;
	}
	beforeEach(() => {
		activeSessions.length = 0;
		registry = new BackgroundJobRegistry(async (prompt) => fakeSession(`result of: ${prompt}`));
	});

	afterEach(async () => {
		await registry.dispose();
	});

	it("runs background jobs, retrieves results, and enforces concurrency cap", async () => {
		const { promise: hold, resolve } = Promise.withResolvers<void>();
		const cappedRegistry = new BackgroundJobRegistry(async (prompt) => fakeSession(`result of: ${prompt}`, hold));
		const firstId = await cappedRegistry.start("build release", { label: "build" });
		const secondId = await cappedRegistry.start("run tests");
		const thirdId = await cappedRegistry.start("audit deps");

		await expect(cappedRegistry.start("overflow")).rejects.toThrow("At most 3");

		const jobs = cappedRegistry.list();
		expect(jobs.map((job) => job.id)).toEqual([firstId, secondId, thirdId]);
		expect(jobs[0]?.label).toBe("build");

		resolve();
		const firstResult = await cappedRegistry.waitFor(firstId);
		expect(firstResult).toEqual({ state: "completed", text: "result of: build release" });
		await cappedRegistry.waitFor(secondId);
		await cappedRegistry.waitFor(thirdId);
		await cappedRegistry.dispose();
	});

	it("cancels running jobs and reports cancelled state", async () => {
		const { promise: hold, resolve } = Promise.withResolvers<void>();
		const slowRegistry = new BackgroundJobRegistry(async () => fakeSession("late", hold));
		const id = await slowRegistry.start("slow work");
		expect(slowRegistry.cancel(id)).toBe(true);
		expect(slowRegistry.cancel(id)).toBe(false);
		resolve();
		const result = await slowRegistry.waitFor(id);
		expect(result.state).toBe("cancelled");
		expect(result.text).toContain("Cancelled");
		await slowRegistry.dispose();
	});
});
