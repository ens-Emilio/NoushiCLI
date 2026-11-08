// SSH host metadata store for `/xomp-ssh`: records non-sensitive connection metadata
// (host, user, port, identity file) per host alias. Private keys are never copied —
// identity files stay at the user's own paths, and the system `ssh` binary plus its
// known_hosts handling remain the trust boundary.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface SshHost {
	alias: string;
	hostname: string;
	user: string | undefined;
	port: number;
	/** Path to the user's identity file; stored by reference, never copied. */
	identityFile: string | undefined;
	/** Exact command prefixes the host permits when set; empty/undefined means consent-only. */
	allowedCommands?: string[];
	/** Command prefixes always refused, even when the allowlist includes them. */
	forbiddenCommands?: string[];
}

interface SshHostsFile {
	hosts: SshHost[];
}

const DEFAULT_PORT = 22;

function readHostsFile(path: string): SshHostsFile {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof value !== "object" || value === null || !("hosts" in value) || !Array.isArray(value.hosts))
			return { hosts: [] };
		return value as SshHostsFile;
	} catch {
		return { hosts: [] };
	}
}

export class SshHostStore {
	private readonly path: string;

	constructor(path: string) {
		this.path = resolve(path);
	}

	private load(): SshHost[] {
		return readHostsFile(this.path).hosts;
	}

	private save(hosts: SshHost[]): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, `${JSON.stringify({ hosts }, null, "\t")}\n`);
	}

	/** Add or replace a host entry; returns the stored entry. */
	add(
		alias: string,
		hostname: string,
		options: { user?: string; port?: number; identityFile?: string } = {},
	): SshHost {
		const aliasTrimmed = alias.trim();
		if (!aliasTrimmed || !/^[A-Za-z0-9_.-]+$/u.test(aliasTrimmed)) throw new Error(`Invalid host alias: ${alias}`);
		if (!hostname.trim()) throw new Error("Hostname must not be empty.");
		const port = options.port ?? DEFAULT_PORT;
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${options.port}`);
		const hosts = this.load().filter((host) => host.alias !== aliasTrimmed);
		const entry: SshHost = {
			alias: aliasTrimmed,
			hostname: hostname.trim(),
			user: options.user?.trim() || undefined,
			port,
			identityFile: options.identityFile?.trim() || undefined,
		};
		hosts.push(entry);
		this.save(hosts);
		return entry;
	}

	/** All stored hosts, sorted by alias. */
	list(): SshHost[] {
		return this.load().sort((a, b) => a.alias.localeCompare(b.alias));
	}

	/** Look up one host by exact alias. */
	get(alias: string): SshHost | undefined {
		return this.load().find((host) => host.alias === alias);
	}

	/** Remove a host entry; returns whether one was removed. */
	remove(alias: string): boolean {
		const hosts = this.load();
		const kept = hosts.filter((host) => host.alias !== alias);
		if (kept.length === hosts.length) return false;
		this.save(kept);
		return true;
	}

	/** Patch one host's mutable fields; refuses unknown aliases. */
	update(alias: string, patch: Partial<Pick<SshHost, "allowedCommands" | "forbiddenCommands">>): SshHost {
		const hosts = this.load();
		const index = hosts.findIndex((host) => host.alias === alias);
		if (index < 0) throw new Error(`No stored host named ${alias}.`);
		hosts[index] = { ...hosts[index], ...patch };
		this.save(hosts);
		return hosts[index];
	}
}
