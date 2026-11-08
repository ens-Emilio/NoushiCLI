// Behavioral tests for the collaboration crypto core: identity persistence with 0600,
// signing/verification, room-key sealing with tamper detection, sealed room-key offers
// across host/guest X25519 pairs, and revocation via rekey.

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	generateCollabIdentity,
	generateIdentity,
	keyFingerprint,
	loadOrCreateIdentity,
	openRoomKey,
	openRoomKeyOffer,
	rotateRoomKey,
	saveIdentity,
	sealRoomKeyOffer,
	sealToRoomKey,
	signPayload,
	verifyPayload,
} from "../src/core/collab-crypto.ts";

describe("identity", () => {
	it("generates distinct keys and a stable fingerprint", () => {
		const first = generateIdentity();
		const second = generateIdentity();
		expect(first.publicKey).not.toBe(second.publicKey);
		expect(keyFingerprint(first.publicKey)).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/u);
		expect(keyFingerprint(first.publicKey)).toBe(keyFingerprint(first.publicKey));
		expect(keyFingerprint(first.publicKey)).not.toBe(keyFingerprint(second.publicKey));
	});

	it("persists with 0600 and refuses overwrite", () => {
		const dir = mkdtempSync(join(tmpdir(), "collab-id-"));
		try {
			const path = join(dir, "nested", "identity.json");
			const identity = loadOrCreateIdentity(path);
			expect(existsSync(path)).toBe(true);
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(() => saveIdentity(identity, path)).toThrow(/already exists/);
			expect(loadOrCreateIdentity(path).publicKey).toBe(identity.publicKey);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("signs and verifies, rejecting tampered payloads and malformed signatures", () => {
		const identity = generateIdentity();
		const signature = signPayload(identity.privateKey, "frame-bytes");
		expect(verifyPayload(identity.publicKey, "frame-bytes", signature)).toBe(true);
		expect(verifyPayload(identity.publicKey, "frame-bytes!", signature)).toBe(false);
		expect(verifyPayload(identity.publicKey, "frame-bytes", "not base64!!")).toBe(false);
	});
});

describe("room key sealing", () => {
	it("round-trips an event payload", () => {
		const roomKey = rotateRoomKey();
		const sealed = sealToRoomKey("transcript.append: hello", roomKey);
		expect(openRoomKey(sealed, roomKey)).toBe("transcript.append: hello");
	});

	it("fails auth on a wrong key or tampered ciphertext", () => {
		const roomKey = rotateRoomKey();
		const sealed = sealToRoomKey("secret event", roomKey);
		expect(() => openRoomKey(sealed, rotateRoomKey())).toThrow();
		const tampered = { ...sealed, ciphertext: Buffer.from("tampered").toString("base64") };
		expect(() => openRoomKey(tampered, roomKey)).toThrow();
	});
});

describe("room key offers", () => {
	it("host seals to a guest and only that guest opens it", () => {
		const host = generateCollabIdentity();
		const guest = generateCollabIdentity();
		const stranger = generateCollabIdentity();
		const roomKey = rotateRoomKey();
		const offer = sealRoomKeyOffer(roomKey, host.x25519Private, guest.x25519Public);
		expect(openRoomKeyOffer(offer, guest.x25519Private)).toEqual(roomKey);
		expect(() => openRoomKeyOffer(offer, stranger.x25519Private)).toThrow();
	});

	it("rekey makes old room keys useless for sealed events", () => {
		const oldKey = rotateRoomKey();
		const sealed = sealToRoomKey("before revocation", oldKey);
		const newKey = rotateRoomKey();
		expect(openRoomKey(sealed, oldKey)).toBe("before revocation");
		expect(() => openRoomKey(sealed, newKey)).toThrow();
	});
});
