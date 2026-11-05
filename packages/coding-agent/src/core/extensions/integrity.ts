import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type ExtensionDigestManifest = Record<string, string>;

/** Verify one extension file against a package-relative SHA-256 manifest entry. */
export async function verifyExtensionDigest(
	packageRoot: string,
	extensionPath: string,
	manifest: ExtensionDigestManifest,
): Promise<{ verified: boolean; actual: string }> {
	const root = resolve(packageRoot);
	const file = resolve(extensionPath);
	const rel = relative(root, file);
	if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
		throw new Error("Extension path must be inside the package root");
	}
	const expected = manifest[rel.split("\\").join("/")];
	if (typeof expected !== "string" || !/^[a-f\d]{64}$/i.test(expected)) {
		throw new Error(`Missing or invalid SHA-256 digest for ${rel}`);
	}
	const actual = createHash("sha256")
		.update(await readFile(file))
		.digest("hex");
	return { verified: actual === expected.toLowerCase(), actual };
}
