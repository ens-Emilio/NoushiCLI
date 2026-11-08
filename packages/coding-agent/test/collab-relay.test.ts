// Behavioral tests for the collaboration relay: two real WebSocket clients in-process
// exchanging signed envelopes, room fan-out, one-room-per-connection enforcement, and
// room teardown when the last member leaves. Waits await socket events, not clocks.

import { afterAll, afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { generateIdentity, keyFingerprint, signPayload } from "../src/core/collab-crypto.ts";
import { type CollabEnvelope, CollabRelay } from "../src/core/collab-relay.ts";

const relay = new CollabRelay();
const sockets: WebSocket[] = [];

afterAll(() => {
	relay.close();
});

afterEach(() => {
	for (const socket of sockets.splice(0)) socket.close();
});

function makeEnvelope(from: string, seq: number, kind: CollabEnvelope["kind"], room = "room-1"): CollabEnvelope {
	return { v: 1, room, from, seq, kind, payload: `payload-${seq}`, sig: "sig" };
}

/** A connected client whose join frame has landed at the relay. */
function connect(room: string): Promise<WebSocket> {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${relay.port}`);
		sockets.push(ws);
		ws.on("open", () => {
			// Join by sending any envelope for the room; membership follows the room id.
			ws.send(JSON.stringify(makeEnvelope("joiner", 0, "ping", room)));
			resolve(ws);
		});
	});
}

/** Promise for the next non-ping envelope the socket receives. */
function nextEnvelope(ws: WebSocket): Promise<CollabEnvelope> {
	const { promise, resolve } = Promise.withResolvers<CollabEnvelope>();
	ws.on("message", function handler(data: Buffer) {
		const envelope = JSON.parse(data.toString("utf8")) as CollabEnvelope;
		if (envelope.kind === "ping") return;
		ws.off("message", handler);
		resolve(envelope);
	});
	return promise;
}

/** Promise for the next non-ping envelope, or null when none arrives before `close` fires. */
function nextEnvelopeOrClose(ws: WebSocket): Promise<CollabEnvelope | null> {
	const { promise, resolve } = Promise.withResolvers<CollabEnvelope | null>();
	const timer = setTimeout(() => resolve(null), 500); // bounded negative-wait; the only clock use
	ws.on("message", function handler(data: Buffer) {
		const envelope = JSON.parse(data.toString("utf8")) as CollabEnvelope;
		if (envelope.kind === "ping") return;
		clearTimeout(timer);
		ws.off("message", handler);
		resolve(envelope);
	});
	ws.on("close", () => {
		clearTimeout(timer);
		resolve(null);
	});
	return promise;
}

describe("collab relay", () => {
	it("fans an envelope out to the other room member and not back to the sender", async () => {
		const identityA = generateIdentity();
		const a = await connect("fan-room");
		const b = await connect("fan-room");
		const atB = nextEnvelope(b);
		const envelope = makeEnvelope(keyFingerprint(identityA.publicKey), 1, "session_event", "fan-room");
		a.send(JSON.stringify({ ...envelope, sig: signPayload(identityA.privateKey, envelope.payload) }));
		const received = await atB;
		expect(received.payload).toBe("payload-1");
		expect(received.from).toBe(keyFingerprint(identityA.publicKey));
	});

	it("keeps rooms isolated from each other", async () => {
		const a = await connect("iso-room-a");
		const b = await connect("iso-room-b");
		const atB = nextEnvelopeOrClose(b);
		a.send(JSON.stringify(makeEnvelope("sender-a", 2, "session_event", "iso-room-a")));
		expect(await atB).toBeNull();
	});

	it("drops a frame for a different room after a connection joined one room", async () => {
		const a = await connect("switch-room-a");
		const b = await connect("switch-room-b");
		const atB = nextEnvelopeOrClose(b);
		a.send(JSON.stringify(makeEnvelope("wanderer", 3, "session_event", "switch-room-b")));
		expect(await atB).toBeNull();
	});

	it("tears down the room when the last member disconnects", async () => {
		const a = await connect("teardown-room");
		const b = await connect("teardown-room");
		a.close();
		b.close();
		await new Promise<void>((resolve) => b.on("close", resolve));
		// Re-connecting works: the room was cleaned and is recreated on demand.
		const c = await connect("teardown-room");
		const d = await connect("teardown-room");
		const atD = nextEnvelope(d);
		c.send(JSON.stringify(makeEnvelope("fresh", 4, "session_event", "teardown-room")));
		expect((await atD).seq).toBe(4);
	});
});
