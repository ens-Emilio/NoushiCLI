// Collaboration session client over the relay: a host that owns the room key and
// approves joins, and a guest that confirms the host fingerprint and opens the key
// offer. Envelope signing uses Ed25519; events are sealed to the room key; a role
// change rekeys so revoked members cannot read post-revocation traffic.

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
	type CollabIdentityFull,
	keyFingerprint,
	openRoomKey,
	openRoomKeyOffer,
	rotateRoomKey,
	type SealedEvent,
	sealRoomKeyOffer,
	sealToRoomKey,
	signPayload,
} from "./collab-crypto.ts";
import type { CollabEnvelope } from "./collab-relay.ts";

export type CollabRole = "host" | "editor" | "observer";

export interface CollabMember {
	id: string;
	role: CollabRole;
}

export interface CollabEvent {
	type: "transcript.append" | "status.update" | "guest.message" | "presence";
	text: string;
}

export interface CollabInvite {
	relayUrl: string;
	roomId: string;
	/** Host fingerprint the guest must confirm out-of-band before joining. */
	hostFingerprint: string;
}

export interface HostOptions {
	relayUrl: string;
	identity: CollabIdentityFull;
	/** Guests wait for explicit approval before receiving the room key. */
	approveJoin: (guestFingerprint: string) => Promise<boolean>;
	/** Role assigned to approved guests. */
	defaultRole?: CollabRole;
}

export interface GuestOptions {
	invite: CollabInvite;
	identity: CollabIdentityFull;
}

export class CollabHost {
	private ws: WebSocket | undefined;
	private roomKey: Buffer | undefined;
	private readonly members = new Map<string, CollabRole>();
	readonly eventLog: CollabEvent[] = [];
	readonly roomId = randomUUID().slice(0, 8);
	private readonly identity: CollabIdentityFull;
	private readonly approveJoin: HostOptions["approveJoin"];
	private readonly defaultRole: CollabRole;
	private relayUrl = "";

	constructor(options: HostOptions) {
		this.identity = options.identity;
		this.approveJoin = options.approveJoin;
		this.defaultRole = options.defaultRole ?? "observer";
	}

	status(): { members: CollabMember[]; events: number } {
		return { members: [...this.members].map(([id, role]) => ({ id, role })), events: this.eventLog.length };
	}

	/** Start hosting: connect, create the room key, and produce the invite. */
	async start(): Promise<CollabInvite> {
		this.roomKey = rotateRoomKey();
		this.members.set(keyFingerprint(this.identity.ed25519.publicKey), "host");
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.ws = new WebSocket(this.relayUrl);
		this.ws.on("open", () => resolve());
		this.ws.on("error", () => reject(new Error(`Relay connection failed: ${this.relayUrl}`)));
		this.ws.on("message", (data: Buffer) => this.handleEnvelope(JSON.parse(data.toString("utf8")) as CollabEnvelope));
		await promise;
		// Register the host in the relay room; membership follows the first frame's room id.
		this.send({
			v: 1,
			room: this.roomId,
			from: keyFingerprint(this.identity.ed25519.publicKey),
			seq: 0,
			kind: "presence",
			payload: JSON.stringify({ role: "host" }),
			sig: signPayload(this.identity.ed25519.privateKey, this.roomId),
		});
		return {
			relayUrl: this.relayUrl,
			roomId: this.roomId,
			hostFingerprint: keyFingerprint(this.identity.ed25519.publicKey),
		};
	}

	/** Set the relay address before start(); the CLI passes its own relay URL. */
	withRelayUrl(url: string): this {
		this.relayUrl = url;
		return this;
	}

	private send(envelope: CollabEnvelope): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("The collaboration socket is closed.");
		this.ws.send(JSON.stringify(envelope));
	}

	private handleEnvelope(envelope: CollabEnvelope): void {
		if (envelope.room !== this.roomId || !this.roomKey) return;
		if (envelope.kind === "key_accept") {
			void this.handleJoin(envelope);
			return;
		}
		if (envelope.kind === "session_event") {
			// Sealed frames arriving at the host are other members' guest.message events.
			this.eventLog.push({ type: "guest.message", text: `(sealed frame from ${envelope.from.slice(0, 8)})` });
		}
	}

	private async handleJoin(envelope: CollabEnvelope): Promise<void> {
		let accepted: boolean;
		try {
			accepted = await this.approveJoin(envelope.from);
		} catch {
			accepted = false;
		}
		if (!accepted || !this.roomKey) return; // deny: no key offer, the guest never reads
		let accept: { identity: { x25519Public: string }; guestFingerprint: string };
		try {
			accept = JSON.parse(envelope.payload) as typeof accept;
		} catch {
			return;
		}
		const guestFingerprint = accept.guestFingerprint ?? envelope.from;
		this.members.set(guestFingerprint, this.defaultRole);
		const offer = sealRoomKeyOffer(this.roomKey, this.identity.x25519Private, accept.identity.x25519Public);
		this.send({
			v: 1,
			room: this.roomId,
			from: keyFingerprint(this.identity.ed25519.publicKey),
			seq: 0,
			kind: "key_offer",
			payload: JSON.stringify({ offer, role: this.defaultRole }),
			sig: signPayload(this.identity.ed25519.privateKey, offer.ciphertext),
		});
	}

	/** Share an event with the room, sealed to the current room key. */
	share(event: CollabEvent): void {
		if (!this.roomKey || !this.ws) throw new Error("The room is not started.");
		const sealed = sealToRoomKey(JSON.stringify(event), this.roomKey);
		this.send({
			v: 1,
			room: this.roomId,
			from: keyFingerprint(this.identity.ed25519.publicKey),
			seq: 0,
			kind: "session_event",
			payload: JSON.stringify(sealed),
			sig: signPayload(this.identity.ed25519.privateKey, sealed.ciphertext),
		});
	}

	/** Revoke a member: rotate the room key so revoked members cannot read on.
	 * Key re-offers to remaining guests land in the next protocol iteration. */
	revoke(memberId: string): void {
		this.members.delete(memberId);
		this.roomKey = rotateRoomKey();
	}

	stop(): void {
		this.ws?.close();
	}
}

export class CollabGuest {
	private ws: WebSocket | undefined;
	private roomKey: Buffer | undefined;
	private myRole: CollabRole | undefined;
	readonly eventLog: CollabEvent[] = [];
	readonly receivedKeyOffer: PromiseWithResolvers<boolean>;
	readonly hostFingerprint: string;
	private readonly invite: CollabInvite;
	private readonly identity: CollabIdentityFull;

	constructor(options: GuestOptions) {
		this.invite = options.invite;
		this.identity = options.identity;
		this.receivedKeyOffer = Promise.withResolvers<boolean>();
		this.hostFingerprint = options.invite.hostFingerprint;
	}

	status(): { role: CollabRole | undefined; events: number } {
		return { role: this.myRole, events: this.eventLog.length };
	}

	/** Join the room: connect and send key_accept. Confirm the host fingerprint
	 * out-of-band first — the invite link is only as trustworthy as its channel. */
	async join(): Promise<boolean> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.ws = new WebSocket(this.invite.relayUrl);
		this.ws.on("open", () => resolve());
		this.ws.on("error", () => reject(new Error(`Relay connection failed: ${this.invite.relayUrl}`)));
		this.ws.on("message", (data: Buffer) => this.handleEnvelope(JSON.parse(data.toString("utf8")) as CollabEnvelope));
		await promise;
		this.ws.send(
			JSON.stringify({
				v: 1,
				room: this.invite.roomId,
				from: keyFingerprint(this.identity.ed25519.publicKey),
				seq: 0,
				kind: "key_accept",
				payload: JSON.stringify({
					identity: { x25519Public: this.identity.x25519Public },
					guestFingerprint: keyFingerprint(this.identity.ed25519.publicKey),
				}),
				sig: signPayload(this.identity.ed25519.privateKey, this.identity.x25519Public),
			}),
		);
		// A denied or absent host never sends the offer; bound the wait so join resolves.
		const offer = await Promise.race([
			this.receivedKeyOffer.promise,
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
		]);
		return offer;
	}

	private handleEnvelope(envelope: CollabEnvelope): void {
		if (envelope.room !== this.invite.roomId) return;
		if (envelope.kind === "key_offer") {
			try {
				const { offer, role } = JSON.parse(envelope.payload) as {
					offer: Parameters<typeof openRoomKeyOffer>[0];
					role: CollabRole;
				};
				this.roomKey = openRoomKeyOffer(offer, this.identity.x25519Private);
				this.myRole = role;
				this.receivedKeyOffer.resolve(true);
			} catch {
				this.receivedKeyOffer.resolve(false); // host denied us or the offer was tampered
			}
			return;
		}
		if (envelope.kind === "session_event" && this.roomKey) {
			try {
				const sealed = JSON.parse(envelope.payload) as SealedEvent;
				this.eventLog.push(JSON.parse(openRoomKey(sealed, this.roomKey)) as CollabEvent);
			} catch {
				// Frame sealed to a key we no longer hold (post-revoke) — ignored.
			}
		}
	}

	sendMessage(text: string): void {
		if (this.myRole === "observer") throw new Error("Observers cannot send messages.");
		if (!this.roomKey || !this.ws) throw new Error("The guest has no room key; join first.");
		const sealed = sealToRoomKey(JSON.stringify({ type: "guest.message", text }), this.roomKey);
		this.ws.send(
			JSON.stringify({
				v: 1,
				room: this.invite.roomId,
				from: keyFingerprint(this.identity.ed25519.publicKey),
				seq: 0,
				kind: "session_event",
				payload: JSON.stringify(sealed),
				sig: signPayload(this.identity.ed25519.privateKey, sealed.ciphertext),
			}),
		);
	}

	leave(): void {
		this.ws?.close();
	}
}
