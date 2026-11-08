// Platform capability detection for `/xomp-computer` and `/xomp-live` status commands.
// Purely diagnostic: reports which input-automation tool (X11/Wayland) and which audio
// capture stack (PipeWire) the current session exposes, with honest unavailability
// elsewhere. No action is ever performed here.

import { existsSync } from "node:fs";

export interface ComputerStatus {
	platform: NodeJS.Platform;
	sessionType: "x11" | "wayland" | "unknown";
	/** The first available automation tool, with the command that would be used. */
	tool: { name: "xdotool" | "ydotool" | "wtype"; command: string } | undefined;
	executionSupported: boolean;
}

export interface LiveStatus {
	platform: NodeJS.Platform;
	/** Whether a PipeWire session directory is present. */
	pipewireDetected: boolean;
	recorder: { name: "pw-record"; command: string } | undefined;
	sttProvider: undefined;
	executionSupported: false;
}
/** Path probes per automation tool; entries are checked in order. */
const AUTOMATION_TOOLS: Array<{ name: "xdotool" | "ydotool" | "wtype"; paths: string[] }> = [
	{ name: "ydotool", paths: ["/usr/bin/ydotool"] },
	{ name: "wtype", paths: ["/usr/bin/wtype"] },
	{ name: "xdotool", paths: ["/usr/bin/xdotool"] },
];

function detectSessionType(env: NodeJS.ProcessEnv): ComputerStatus["sessionType"] {
	if (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === "wayland") return "wayland";
	if (env.DISPLAY || env.XDG_SESSION_TYPE === "x11") return "x11";
	return "unknown";
}

/** Detect the input-automation capabilities of the current session. */
export function detectComputerStatus(
	env: NodeJS.ProcessEnv = process.env,
	hasPath: (path: string) => boolean = existsSync,
): ComputerStatus {
	const platform = process.platform;
	const sessionType = platform === "linux" ? detectSessionType(env) : "unknown";
	for (const tool of AUTOMATION_TOOLS) {
		const path = tool.paths.find((candidate) => hasPath(candidate));
		if (path) {
			return { platform, sessionType, tool: { name: tool.name, command: path }, executionSupported: false };
		}
	}
	return { platform, sessionType, tool: undefined, executionSupported: false };
}

/** Detect audio capture capabilities for /xomp-live. */
export function detectLiveStatus(hasPath: (path: string) => boolean = existsSync): LiveStatus {
	const platform = process.platform;
	const pipewireDetected =
		platform === "linux" && (existsSync("/run/user/1000/pipewire-0") || Boolean(process.env.PIPEWIRE_REMOTE));
	return {
		platform,
		pipewireDetected,
		recorder:
			pipewireDetected && hasPath("/usr/bin/pw-record")
				? { name: "pw-record", command: "/usr/bin/pw-record" }
				: undefined,
		// The STT provider decision (local whisper vs API) is an open review item.
		sttProvider: undefined,
		executionSupported: false,
	};
}
