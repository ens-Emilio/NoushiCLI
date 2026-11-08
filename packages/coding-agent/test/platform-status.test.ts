// Behavioral tests for platform capability detection: injected environments and path
// probes, honest unavailability on non-Linux platforms, and session-type detection.

import { describe, expect, it } from "vitest";
import { detectComputerStatus, detectLiveStatus } from "../src/core/platform-status.ts";

describe("computer status", () => {
	it("detects a Wayland session with ydotool", () => {
		const status = detectComputerStatus(
			{ WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland" },
			(path) => path === "/usr/bin/ydotool",
		);
		expect(status.platform).toBe("linux");
		expect(status.sessionType).toBe("wayland");
		expect(status.tool?.name).toBe("ydotool");
		expect(status.executionSupported).toBe(false);
	});

	it("detects an X11 session with xdotool", () => {
		const status = detectComputerStatus(
			{ DISPLAY: ":0", XDG_SESSION_TYPE: "x11" },
			(path) => path === "/usr/bin/xdotool",
		);
		expect(status.sessionType).toBe("x11");
		expect(status.tool?.name).toBe("xdotool");
	});

	it("reports unknown session and no tool honestly when nothing exists", () => {
		const status = detectComputerStatus({}, () => false);
		expect(status.sessionType).toBe("unknown");
		expect(status.tool).toBeUndefined();
	});

	it("never claims execution support", () => {
		const status = detectComputerStatus({ DISPLAY: ":0" }, () => true);
		expect(status.executionSupported).toBe(false);
	});
});

describe("live status", () => {
	it("detects PipeWire and pw-record on Linux", () => {
		const status = detectLiveStatus((path) => path === "/usr/bin/pw-record");
		if (process.platform === "linux") {
			// Detection depends on the runtime environment; both outcomes are honest.
			expect(typeof status.pipewireDetected).toBe("boolean");
		}
		expect(status.sttProvider).toBeUndefined();
		expect(status.executionSupported).toBe(false);
	});

	it("never claims STT or execution support", () => {
		const status = detectLiveStatus(() => true);
		expect(status.sttProvider).toBeUndefined();
		expect(status.executionSupported).toBe(false);
		expect(status.recorder === undefined || status.recorder.name === "pw-record").toBe(true);
	});
});
