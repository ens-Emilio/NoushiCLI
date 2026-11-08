// Second-model advisor role for `/xomp-advisor` and `/xomp-prewalk`, implementing the
// design in docs/advisor-role-design.md: an off→ready→busy→ready→off state machine with
// its own redacted transcript projection and usage metering. The advisor has no tools,
// never writes to the main transcript, and runs only while the main session is idle.

export type AdvisorState = "off" | "ready" | "busy" | "error";

export interface AdvisorConfig {
	model: string;
	/** Optional system prompt override for the advisor role. */
	systemPrompt?: string;
	/** Whether the advisor can be asked at all; explicit-trigger-only in v1. */
	autoEngage: boolean;
}

export interface AdvisorUsage {
	inputTokens: number;
	outputTokens: number;
}

export interface AdvisorMessage {
	role: "user" | "assistant";
	content: string;
}

export interface TranscriptRedactor {
	/** Return `text` with secrets removed; the projection never carries raw secrets. */
	redact: (text: string) => string;
}

export interface AdvisorModelClient {
	/** Complete a single advisor turn. Tests inject a fake; no network by default. */
	complete(messages: AdvisorMessage[], systemPrompt: string): Promise<{ text: string; usage: AdvisorUsage }>;
}

export interface MainTranscriptSource {
	/** Recent messages of the main session, oldest first, already bounded by the caller. */
	recent(): Array<{ role: string; content: string }>;
}

const PROJECTION_PREFIX = "[advisor projection] ";
const ADVISOR_CONTEXT_MARKER = "[advisor] ";

/** The advisor role: one instance per session, created lazily by /xomp-advisor on. */
export class AdvisorRole {
	private state: AdvisorState = "off";
	private config: AdvisorConfig | undefined;
	private readonly messages: AdvisorMessage[] = [];
	private readonly usage: AdvisorUsage = { inputTokens: 0, outputTokens: 0 };
	private readonly redactor: TranscriptRedactor;
	private readonly modelClient: AdvisorModelClient;
	private readonly mainTranscript: MainTranscriptSource;
	private readonly isMainIdle: () => boolean;

	constructor(options: {
		redactor: TranscriptRedactor;
		modelClient: AdvisorModelClient;
		mainTranscript: MainTranscriptSource;
		isMainIdle: () => boolean;
	}) {
		this.redactor = options.redactor;
		this.modelClient = options.modelClient;
		this.mainTranscript = options.mainTranscript;
		this.isMainIdle = options.isMainIdle;
	}

	getState(): AdvisorState {
		return this.state;
	}

	getConfig(): AdvisorConfig | undefined {
		return this.config;
	}

	getUsage(): AdvisorUsage {
		return { ...this.usage };
	}

	getTranscript(): readonly AdvisorMessage[] {
		return this.messages;
	}

	/** Turn the role on with a validated config. */
	enable(config: AdvisorConfig): void {
		if (!config.model) throw new Error("Advisor requires a model id.");
		this.config = { ...config, autoEngage: config.autoEngage ?? false };
		this.state = "ready";
	}

	/** Turn the role off and drop its transcript. */
	disable(): void {
		this.config = undefined;
		this.messages.length = 0;
		this.state = "off";
	}

	/** Ask the advisor a question. Refuses while off, busy, or when the main session is streaming. */
	async ask(question: string): Promise<string> {
		if (this.state === "off" || !this.config)
			throw new Error("The advisor is off; run /xomp-advisor on <model> first.");
		if (this.state === "busy") throw new Error("The advisor is already answering a question.");
		if (!this.isMainIdle()) throw new Error("The advisor only runs while the main session is idle.");
		this.state = "busy";
		try {
			const projection = this.mainTranscript.recent().map((message) => ({
				role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
				content: PROJECTION_PREFIX + this.redactor.redact(message.content),
			}));
			this.messages.push(...projection, { role: "user", content: this.redactor.redact(question) });
			const reply = await this.modelClient.complete(
				this.messages,
				this.config.systemPrompt ?? `${ADVISOR_CONTEXT_MARKER}You are a quick second-opinion assistant.`,
			);
			this.usage.inputTokens += reply.usage.inputTokens;
			this.usage.outputTokens += reply.usage.outputTokens;
			this.messages.push({ role: "assistant", content: reply.text });
			this.state = "ready";
			return reply.text;
		} catch (error) {
			this.state = "error";
			throw error;
		}
	}

	/** Reset the error state back to ready after a failure has been acknowledged. */
	acknowledgeError(): void {
		if (this.state === "error" && this.config) this.state = "ready";
	}

	/** One-shot prewalk: create a temporary role, ask, dispose. */
	static async prewalk(
		question: string,
		options: {
			redactor: TranscriptRedactor;
			modelClient: AdvisorModelClient;
			mainTranscript: MainTranscriptSource;
			isMainIdle: () => boolean;
			config: AdvisorConfig;
		},
	): Promise<string> {
		const role = new AdvisorRole(options);
		role.enable(options.config);
		try {
			return await role.ask(question);
		} finally {
			role.disable();
		}
	}
}
