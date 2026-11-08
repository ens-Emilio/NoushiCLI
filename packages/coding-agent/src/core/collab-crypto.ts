// Collaboration crypto core for the protocol in docs/collab-protocol-draft.md, built on
// node:crypto primitives (Ed25519 identity, X25519 key agreement via diffieHellman,
// ChaCha20-Poly1305 sealing) instead of libsodium — same guarantees, no new dependency.
// Identity files are 0600; room keys are 256-bit and rotate on every role change.

import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	randomBytes,
	sign,
	verify,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface CollabIdentity {
	publicKey: string;
	privateKey: string;
}

export const IDENTITY_FILE_MODE = 0o600;
const KEY_CIPHER = "chacha20-poly1305";
const KEY_CIPHER_NONCE_BYTES = 12;
/** DER prefix of an SPKI-encoded X25519 public key (12 bytes before the raw 32). */
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

/** Generate a fresh Ed25519 identity pair (PEM-encoded). */
export function generateIdentity(): CollabIdentity {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	return {
		publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
		privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
	};
}

/** Persist an identity to `path` with 0600 permissions; refuses to overwrite. */
export function saveIdentity(identity: CollabIdentity, path: string): void {
	if (existsSync(path)) throw new Error(`Identity file already exists: ${path}`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(identity, null, "\t")}\n`, { mode: IDENTITY_FILE_MODE });
}

/** Load an identity from `path`; creates and saves a new one when absent. */
export function loadOrCreateIdentity(path: string): CollabIdentity {
	if (existsSync(path)) {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (
			typeof value === "object" &&
			value !== null &&
			typeof (value as CollabIdentity).publicKey === "string" &&
			typeof (value as CollabIdentity).privateKey === "string"
		) {
			return value as CollabIdentity;
		}
		throw new Error(`Identity file at ${path} is malformed.`);
	}
	const identity = generateIdentity();
	saveIdentity(identity, path);
	return identity;
}

/** Short stable fingerprint of a public key, hex phrase form (XXXX-XXXX-XXXX-XXXX). */
export function keyFingerprint(publicKeyPem: string): string {
	const digest = createHash("sha256").update(publicKeyPem).digest("hex");
	return (digest.slice(0, 16).match(/.{4}/gu) ?? []).join("-");
}

/** Sign arbitrary bytes with an Ed25519 private key; returns base64. */
export function signPayload(privateKeyPem: string, payload: string): string {
	return sign(null, Buffer.from(payload, "utf8"), createPrivateKey(privateKeyPem)).toString("base64");
}

/** Verify a base64 signature over payload bytes; returns false for malformed input. */
export function verifyPayload(publicKeyPem: string, payload: string, signatureBase64: string): boolean {
	try {
		return verify(
			null,
			Buffer.from(payload, "utf8"),
			createPublicKey(publicKeyPem),
			Buffer.from(signatureBase64, "base64"),
		);
	} catch {
		return false;
	}
}

export interface SealedEvent {
	nonce: string;
	ciphertext: string;
	authTag: string;
}

/** Seal an event payload to the current room key (ChaCha20-Poly1305). */
export function sealToRoomKey(payload: string, roomKey: Buffer): SealedEvent {
	if (roomKey.length !== 32) throw new Error("Room keys are 32 bytes.");
	const nonce = randomBytes(KEY_CIPHER_NONCE_BYTES);
	const cipher = createCipheriv(KEY_CIPHER, roomKey, nonce);
	const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
	return {
		nonce: nonce.toString("base64"),
		ciphertext: ciphertext.toString("base64"),
		authTag: cipher.getAuthTag().toString("base64"),
	};
}

/** Open a room-key-sealed event; throws on auth failure (wrong key or tampering). */
export function openRoomKey(sealed: SealedEvent, roomKey: Buffer): string {
	if (roomKey.length !== 32) throw new Error("Room keys are 32 bytes.");
	const decipher = createDecipheriv(KEY_CIPHER, roomKey, Buffer.from(sealed.nonce, "base64"));
	decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
	return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

export interface SealedKeyOffer {
	nonce: string;
	ciphertext: string;
	authTag: string;
	/** The host's raw X25519 public key (base64). */
	ephemeralPublic: string;
}

/** Host-side: seal the room key to one guest via X25519 ECDH (host static key ↔
 * guest raw public key), deriving the wrapping key with SHA-256. */
export function sealRoomKeyOffer(
	roomKey: Buffer,
	hostX25519PrivatePem: string,
	guestX25519PublicBase64: string,
): SealedKeyOffer {
	if (roomKey.length !== 32) throw new Error("Room keys are 32 bytes.");
	const hostPrivate = createPrivateKey(hostX25519PrivatePem);
	const hostPublic = createPublicKey(hostPrivate);
	const guestKey = createPublicKey({
		key: { kty: "OKP", crv: "X25519", x: Buffer.from(guestX25519PublicBase64, "base64").toString("base64url") },
		format: "jwk",
	});
	const shared = diffieHellman({ privateKey: hostPrivate, publicKey: guestKey });
	const derived = createHash("sha256").update(shared).digest();
	const nonce = randomBytes(KEY_CIPHER_NONCE_BYTES);
	const cipher = createCipheriv(KEY_CIPHER, derived, nonce);
	const ciphertext = Buffer.concat([cipher.update(roomKey), cipher.final()]);
	return {
		nonce: nonce.toString("base64"),
		ciphertext: ciphertext.toString("base64"),
		authTag: cipher.getAuthTag().toString("base64"),
		ephemeralPublic: hostPublic
			.export({ type: "spki", format: "der" })
			.subarray(X25519_SPKI_PREFIX.length)
			.toString("base64"),
	};
}

/** Guest-side: open a room-key offer with the guest's X25519 private PEM. */
export function openRoomKeyOffer(offer: SealedKeyOffer, guestX25519PrivatePem: string): Buffer {
	const guestPrivate = createPrivateKey(guestX25519PrivatePem);
	const hostKey = createPublicKey({
		key: { kty: "OKP", crv: "X25519", x: Buffer.from(offer.ephemeralPublic, "base64").toString("base64url") },
		format: "jwk",
	});
	const shared = diffieHellman({ privateKey: guestPrivate, publicKey: hostKey });
	const derived = createHash("sha256").update(shared).digest();
	const decipher = createDecipheriv(KEY_CIPHER, derived, Buffer.from(offer.nonce, "base64"));
	decipher.setAuthTag(Buffer.from(offer.authTag, "base64"));
	return Buffer.concat([decipher.update(Buffer.from(offer.ciphertext, "base64")), decipher.final()]);
}

export interface CollabIdentityFull {
	ed25519: CollabIdentity;
	/** Raw 32-byte X25519 public key, base64. */
	x25519Public: string;
	/** PKCS8 PEM of the X25519 private key. */
	x25519Private: string;
}

/** Full identity: Ed25519 for signing plus an X25519 key for room-key agreement. */
export function generateCollabIdentity(): CollabIdentityFull {
	const ed25519 = generateIdentity();
	const x25519 = generateKeyPairSync("x25519");
	return {
		ed25519,
		x25519Public: x25519.publicKey
			.export({ type: "spki", format: "der" })
			.subarray(X25519_SPKI_PREFIX.length)
			.toString("base64"),
		x25519Private: x25519.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
	};
}

/** Rotate the room key: returns a fresh 32-byte key. Events sealed to the previous
 * key become unreadable — that is the revocation guarantee. */
export function rotateRoomKey(): Buffer {
	return randomBytes(32);
}
