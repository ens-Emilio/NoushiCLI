import { foregroundAnsi, isAppleTerminalSession, rgbColor } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

const GREEN = rgbColor(47, 101, 92);
const RESET = "\x1b[0m";

export function noushiLogoLines(): string[] {
	const mode = theme.getColorMode();
	const green = foregroundAnsi(GREEN, mode);
	return [
		`${green}█   █${RESET}`,
		`${green}██  █${RESET}`,
		`${green}█ █ █${RESET}`,
		`${green}█  ██${RESET}`,
		`${green}█   █${RESET}`,
	];
}

export function supportsNoushiLogo(): boolean {
	return !isAppleTerminalSession();
}

export function noushiWordmark(): string {
	const mode = theme.getColorMode();
	return `${foregroundAnsi(GREEN, mode)}Noushi${RESET}`;
}
