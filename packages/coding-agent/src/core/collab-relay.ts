// Stateless relay router for the collaboration protocol: WebSocket server that fans
// each envelope out to every other member of a room. The relay sees only the envelope
// (room id, sender key, signed payload); it never holds keys or plaintext and stores
// nothing. Replay/strike guards are client-side per the protocol draft.

import { createServer, type Server } from "node:http";
import type { WebSocketServer as WsServerType } from "ws";
import WebSocket, { WebSocketServer, type WebSocket as WsSocket } from "ws";
export interface CollabEnvelope {
	v: 1;
	room: string;
	from: string;
	seq: number;
	kind: "session_event" | "key_offer" | "key_accept" | "role_change" | "presence" | "ping" | "leave";
	payload: string;
	sig: string;
}

function isEnvelope(value: unknown): value is CollabEnvelope {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<CollabEnvelope>;
	return (
		record.v === 1 &&
		typeof record.room === "string" &&
		record.room.length > 0 &&
		typeof record.from === "string" &&
		typeof record.seq === "number" &&
		typeof record.payload === "string" &&
		typeof record.sig === "string" &&
		typeof record.kind === "string"
	);
}

export class CollabRelay {
	private readonly server: Server;
	private readonly wss: WsServerType;
	private readonly rooms = new Map<string, Set<WsSocket>>();
	readonly port: number;

	constructor(port = 0) {
		this.server = createServer();
		this.wss = new WebSocketServer({ noServer: true });
		this.server.on("upgrade", (request, socket, head) => {
			this.wss.handleUpgrade(request, socket, head, (ws: WsSocket) => {
				this.wss.emit("connection", ws, request);
			});
		});
		this.wss.on("connection", (ws: WsSocket) => {
			let room: string | undefined;
			ws.on("message", (data: Buffer) => {
				let envelope: unknown;
				try {
					envelope = JSON.parse(data.toString("utf8"));
				} catch {
					return; // malformed frames are dropped; the relay is dumb by design
				}
				if (!isEnvelope(envelope)) return;
				if (room && room !== envelope.room) return; // one room per connection
				room = envelope.room;
				let members = this.rooms.get(room);
				if (!members) {
					members = new Set();
					this.rooms.set(room, members);
				}
				members.add(ws);
				const frame = data.toString("utf8");
				for (const member of members) {
					if (member !== ws && member.readyState === WebSocket.OPEN) member.send(frame);
				}
			});
			ws.on("close", () => {
				if (!room) return;
				const members = this.rooms.get(room);
				if (!members) return;
				members.delete(ws);
				if (members.size === 0) this.rooms.delete(room);
			});
		});
		this.server.listen(port);
		this.port = (this.server.address() as { port: number }).port;
	}

	close(): void {
		this.wss.close();
		this.server.close();
	}
}
