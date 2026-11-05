import { spawnSync } from "node:child_process";

const SERVICE_NAME = "noushi-cli";

export interface KeyringCommandResult {
	status: number | null;
	stdout: string;
}

export type KeyringCommandRunner = (command: string, args: string[], input?: string) => KeyringCommandResult;

export interface KeyringOptions {
	platform?: NodeJS.Platform;
	run?: KeyringCommandRunner;
}

function run(command: string, args: string[], input?: string): KeyringCommandResult {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		input,
		stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
	});
	return { status: result.status, stdout: result.stdout ?? "" };
}

function commandResult(options?: KeyringOptions): KeyringCommandRunner {
	return options?.run ?? run;
}

export function readKeyringSecret(
	account: string,
	service = SERVICE_NAME,
	options?: KeyringOptions,
): string | undefined {
	const execute = commandResult(options);
	const platform = options?.platform ?? process.platform;
	let result: KeyringCommandResult;
	if (platform === "darwin")
		result = execute("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
	else if (platform === "linux") result = execute("secret-tool", ["lookup", "service", service, "account", account]);
	else return undefined;
	if (result.status !== 0) return undefined;
	return result.stdout.replace(/\r?\n$/, "") || undefined;
}

export function storeKeyringSecret(
	account: string,
	secret: string,
	service = SERVICE_NAME,
	options?: KeyringOptions,
): boolean {
	const execute = commandResult(options);
	const platform = options?.platform ?? process.platform;
	if (platform === "darwin") {
		return (
			execute("security", ["add-generic-password", "-U", "-s", service, "-a", account, "-w"], secret).status === 0
		);
	}
	if (platform === "linux") {
		return (
			execute("secret-tool", ["store", `--label=Noushi ${account}`, "service", service, "account", account], secret)
				.status === 0
		);
	}
	return false;
}

export function deleteKeyringSecret(account: string, service = SERVICE_NAME, options?: KeyringOptions): boolean {
	const execute = commandResult(options);
	const platform = options?.platform ?? process.platform;
	if (platform === "darwin")
		return execute("security", ["delete-generic-password", "-s", service, "-a", account]).status === 0;
	if (platform === "linux")
		return execute("secret-tool", ["clear", "service", service, "account", account]).status === 0;
	return false;
}
