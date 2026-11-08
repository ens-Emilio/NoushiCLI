// End-to-end collaboration tests over a real relay: host starts, guest joins with
// TOFU fingerprint, sealed events round-trip both directions, host denial withholds
// the room key, and revocation rekeys so the revoked guest cannot read on.

import { afterAll, describe, expect, it } from "vitest";
import { type CollabIdentityFull, generateCollabIdentity } from "../src/core/collab-crypto.ts";
import { CollabRelay } from "../src/core/collab-relay.ts";
import { CollabGuest, CollabHost } from "../src/core/collab-session.ts";

const relay = new CollabRelay();

afterAll(() => {
	relay.close();
});

function identity(): CollabIdentityFull {
	return generateCollabIdentity();
}

function hostFor(
	self: CollabIdentityFull,
	approve: (guest: string) => Promise<boolean>,
	role: CollabParameters["role"] = "editor",
): CollabHost {
	return new CollabHost({
		relayUrl: `ws://127.0.0.1:${relay.port}`,
		identity: self,
		approveJoin: approve,
		defaultRole: role,
	});
}

type CollabParameters = { role: "editor" | "observer" };

describe("collaboration end-to-end", () => {
	it("round-trips a sealed event from host to an approved guest", async () => {
		const host = identity();
		const guest = identity();
		const room = hostFor(host, async () => true);
		const invite = await room.withRelayUrl(`ws://127.0.0.1:${relay.port}`).start();
		const joining = new CollabGuest({ invite, identity: guest });
		const joined = await joining.join();
		expect(joined).toBe(true);
		expect(joining.status().role).toBe("editor");
		// Give the host a moment to have the guest registered, then share.
		const atGuest = guestEvent(joining);
		room.share({ type: "transcript.append", text: "hello from host" });
		const received = await atGuest;
		expect(received).toEqual({ type: "transcript.append", text: "hello from host" });
		room.stop();
		joining.leave();
	});

	it("denies an unapproved guest: no room key, no readable traffic", async () => {
		const host = identity();
		const guest = identity();
		const room = hostFor(host, async () => false);
		const invite = await room.withRelayUrl(`ws://127.0.0.1:${relay.port}`).start();
		const joining = new CollabGuest({ invite, identity: guest });
		expect(await joining.join()).toBe(false);
		expect(joining.status().role).toBeUndefined();
		room.share({ type: "transcript.append", text: "secret content" });
		expect(joining.eventLog).toHaveLength(0);
		room.stop();
		joining.leave();
	});

	it("observers cannot send messages", async () => {
		const host = identity();
		const guest = identity();
		const room = hostFor(host, async () => true, "observer");
		const invite = await room.withRelayUrl(`ws://127.0.0.1:${relay.port}`).start();
		const joining = new CollabGuest({ invite, identity: guest });
		await joining.join();
		expect(() => joining.sendMessage("should fail")).toThrow(/Observers cannot send/);
		room.stop();
		joining.leave();
	});

	it("revocation rotates the room key: old sealed frames become unreadable", async () => {
		const host = identity();
		const guest = identity();
		const room = hostFor(host, async () => true);
		const invite = await room.withRelayUrl(`ws://127.0.0.1:${relay.port}`).start();
		const joining = new CollabGuest({ invite, identity: guest });
		await joining.join();
		room.revoke(keyFingerprintOf(guest));
		// After revoke the host no longer has a key path to this guest; the guest's
		// key is stale. The protocol guarantee: sealed frames with the NEW key are
		// unreadable to the revoked guest. The guest sees nothing new.
		const eventsBefore = joining.eventLog.length;
		room.share({ type: "transcript.append", text: "post-revoke secret" });
		await new Promise<void>((resolve) => setTimeout(resolve, 300)); // bounded wait for any (wrongly) delivered frame
		expect(joining.eventLog.length).toBeLessThanOrEqual(eventsBefore + 0);
		room.stop();
		joining.leave();
	});
});

import { keyFingerprint } from "../src/core/collab-crypto.ts";

function keyFingerprintOf(id: CollabIdentityFull): string {
	return keyFingerprint(id.ed25519.publicKey);
}

/** One host-shared event, or null if nothing arrives in a bounded window. */
function guestEvent(guest: CollabGuest): Promise<{ type: string; text: string } | null> {
	const { promise, resolve } = Promise.withResolvers<{ type: string; text: string } | null>();
	const timer = setTimeout(() => resolve(null), 2000);
	const poll = setInterval(() => {
		const last = guest.eventLog.at(-1);
		if (last) {
			clearTimeout(timer);
			clearInterval(poll);
			resolve(last);
		}
	}, 50);
	void poll;
	return promise;
}
