// Background job registry: runs `/xomp-tan` work in child in-memory sessions so the parent
// session stays interactive. Jobs are capped, cancellable, and their final assistant message
// is retrievable; a job dies when the registry (and with it the parent session) is disposed.

import { randomUUID } from "node:crypto";
import type { AgentSession } from "./agent-session.ts";

export interface BackgroundJobInfo {
	id: string;
	label: string;
	state: "running" | "completed" | "error" | "cancelled";
	startedAt: string;
}

export interface BackgroundJobResult {
	state: "completed" | "error" | "cancelled";
	/** Final assistant text, or the failure/abort reason. */
	text: string;
}

export const BACKGROUND_JOB_LIMIT = 3;

interface BackgroundJob {
	id: string;
	label: string;
	prompt: string;
	state: "running" | "completed" | "error" | "cancelled";
	startedAt: string;
	session: AgentSession | undefined;
	promise: Promise<void>;
	result?: BackgroundJobResult;
}

export class BackgroundJobRegistry {
	private readonly jobs = new Map<string, BackgroundJob>();
	private disposed = false;
	private readonly startChildSession: (prompt: string) => Promise<AgentSession>;

	constructor(startChildSession: (prompt: string) => Promise<AgentSession>) {
		this.startChildSession = startChildSession;
	}

	/** Start `prompt` in a child in-memory session. Returns the job id. */
	async start(prompt: string, options: { label?: string } = {}): Promise<string> {
		if (this.disposed) throw new Error("The background job registry is disposed; start a new session.");
		const running = [...this.jobs.values()].filter((job) => job.state === "running");
		if (running.length >= BACKGROUND_JOB_LIMIT) {
			throw new Error(`At most ${BACKGROUND_JOB_LIMIT} background jobs may run at once; cancel one first.`);
		}
		const job: BackgroundJob = {
			id: randomUUID().slice(0, 8),
			label: options.label ?? prompt.slice(0, 60),
			prompt,
			state: "running",
			startedAt: new Date().toISOString(),
			session: undefined,
			promise: Promise.resolve(),
		};
		this.jobs.set(job.id, job);
		job.promise = (async () => {
			try {
				const session = await this.startChildSession(prompt);
				job.session = session;
				if (job.state !== "running") return;
				await session.prompt(prompt);
				if (job.state !== "running") return;
				const last = [...session.messages].reverse().find((message) => message.role === "assistant");
				job.state = "completed";
				job.result = { state: "completed", text: messageText(last) };
			} catch (error) {
				if (job.state === "running") {
					job.state = "error";
					job.result = { state: "error", text: error instanceof Error ? error.message : String(error) };
				}
			}
		})();
		return job.id;
	}

	/** List all jobs, oldest first. */
	list(): BackgroundJobInfo[] {
		return [...this.jobs.values()].map(({ id, label, state, startedAt }) => ({ id, label, state, startedAt }));
	}

	/** Abort a running job. Returns false when the id is unknown or already settled. */
	cancel(id: string): boolean {
		const job = this.jobs.get(id);
		if (!job || job.state !== "running") return false;
		job.state = "cancelled";
		job.result = { state: "cancelled", text: "Cancelled by /xomp-jobs cancel." };
		job.session?.abort();
		return true;
	}

	/** The settled result of a job, or undefined while it is still running. */
	resultOf(id: string): BackgroundJobResult | undefined {
		return this.jobs.get(id)?.result;
	}

	/** Wait until a job settles, then return its result. */
	async waitFor(id: string): Promise<BackgroundJobResult> {
		const job = this.jobs.get(id);
		if (!job) throw new Error(`Unknown background job: ${id}`);
		await job.promise;
		return job.result ?? { state: job.state as BackgroundJobResult["state"], text: "" };
	}

	/** Abort every running job; called when the parent session disposes. */
	async dispose(): Promise<void> {
		this.disposed = true;
		for (const job of this.jobs.values()) {
			if (job.state === "running") this.cancel(job.id);
		}
		const pending = [...this.jobs.values()].map((job) => job.promise);
		await Promise.allSettled(pending);
		this.jobs.clear();
	}
}

function messageText(message: unknown): string {
	if (typeof message !== "object" || message === null || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				"type" in part &&
				part.type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => (part as { text: string }).text)
		.join("\n");
}
