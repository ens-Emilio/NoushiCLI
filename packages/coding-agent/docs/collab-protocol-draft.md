# Noushi Collaboration Protocol — Draft

Status: design document. No code implements this protocol yet; `/xomp-collab`, `/xomp-join`, and `/xomp-leave` remain unregistered until a reviewed relay and the client below exist. This draft defines the messages, cryptography, identity model, roles, and transport so a future implementation starts from a reviewed contract instead of improvising one.

## Goals

1. Two or more Noushi users share one session transcript in near-real-time, each from their own machine and account.
2. The relay operator can route but not read: all session content is end-to-end encrypted.
3. Guests are restricted by explicit roles; the host grants and revokes at will.
4. No cloud account, no phone-home: the relay is stateless and swappable (self-hosted first).

## Non-goals (v1)

- Message-history backfill beyond the shared ring buffer (each client replays from the session file if needed).
- Presence across devices of the same identity.
- Collaborative editing of the same editor buffer; collaboration is at the conversation/tool-event level.

## Identity

- Each participant generates an Ed25519 keypair locally. The public key is the identity: `noushi-collab-<base64url(pubkey)>`.
- The long-term key lives under `~/.noushi/agent/collab-identity.json` (mode 0600), created on first use with explicit user consent.
- **Trust-on-first-use (TOFU) for peer keys**: the host fingerprint is shown as a short hex phrase and confirmed out-of-band (voice/chat) before joining. Clients pin the verified peer keys for the room's lifetime.
- Host authenticity is the joining decision: the invite link carries the host's public-key fingerprint, and the join flow refuses to continue until the user confirms it matches what they received out-of-band.

## Cryptography

- **Primitives**: X25519 (ECDH), Ed25519 (signing), XSalsa20-Poly1305 (secretbox) — all from libsodium (`sodium-native` or WASM `libsodium-wrappers`; decision pinned at implementation review, no substitutions without re-review).
- **Room key**: the host generates a random 256-bit room key per session. Every event is sealed to the room key.
- **Key distribution (sealed sender → recipient)**: the host performs X25519(host_static, guest_ephemeral) per joining guest and delivers the room key inside a sealed box addressed to the guest's Ed25519 identity. Guests never see each other's key material; they see only the room key.
- **Rekeying**: on every role change (promote/demote/revoke) the host rotates the room key and redistributes as above. A revoked guest cannot read post-revocation traffic even if it keeps receiving relay frames.
- **Per-event authentication**: each event carries the sender's Ed25519 signature over the ciphertext plus sequence number; clients reject unsigned or out-of-sequence events.

## Transport

- WebSocket relay, stateless routing only. The relay sees: connection metadata, room ids, encrypted frames, and join/leave timing. It never sees plaintext or keys.
- Frame envelope (relay-visible):

```jsonc
{
  "v": 1,
  "room": "<room-id>",
  "from": "<sender pubkey b64url>",
  "seq": 42,
  "kind": "session_event | key_offer | key_accept | role_change | ping",
  "payload": "<base64 ciphertext or signed control blob>",
  "sig": "<base64 Ed25519 signature over payload bytes>"
}
```

- Delivery: at-most-once fan-out to currently connected guests; ordering enforced client-side by `seq` per sender.
- The reference relay is a small self-hosted Node service (single file, no database) shipped as `noushi-relay`; production relays must implement exactly this envelope and nothing more.

## Roles

| Role | Capabilities |
|------|--------------|
| `host` | Owns the room and room key. Approves joins, changes roles, rekeys. The host is the session owner's Noushi process. |
| `editor` | May send user messages and (with the model loop) trigger turns through the host's session. Sees tool results. |
| `observer` | Read-only: sees the transcript stream and status events; cannot inject messages or trigger turns. |

- A guest's role is bound inside its key-offer envelope; a role change rekeys, so stale keys never grant new roles.
- Guest messages from `observer` are dropped by the host before any model turn; no prompt-injection surface from read-only peers.

## Message kinds (decrypted payload)

1. `transcript.append` — one serialized `SessionEntry` as it lands in the host's session file.
2. `status.update` — streaming indicator, model name, token usage deltas.
3. `guest.message` — editor-role text injection; the host enqueues it as a steering message with a `via guest <identity>` marker visible in the transcript.
4. `tool.event` — tool call start/end for observers, redacted by the host's existing secret-redaction rules.
5. `presence` — join/leave/role of every participant (signed by the host).

## Join flow

1. Host: `/xomp-collab start` → creates room, prints `noushi://collab/<room-id>@<host-fingerprint>` and waits.
2. Guest: `/xomp-join <link>` → shows host fingerprint for out-of-band confirmation → connects → sends `key_accept` (its identity + ephemeral X25519).
3. Host UI confirms or denies the join; on confirm sends `key_offer` (room key + assigned role) and `presence`.
4. Both sides emit `presence`; the guest starts receiving `transcript.append` events (no history backfill in v1; guests may read the session file from a shared export instead).
5. `/xomp-leave` (guest) or host revoke → immediate rekey by the host.

## Failure and abuse handling

- Duplicate `seq` from a sender ⇒ disconnect that sender's identity (replay guard).
- Invalid signature ⇒ drop frame, count strikes, disconnect after 3.
- Relay unreachable ⇒ guests show the reconnect backoff; the host session continues untouched (collaboration is always optional).
- Rate limits are client-side per room (relay is dumb); hosts cap editors at 5 by default.

## Implementation plan (after this draft is approved)

1. Crypto core with unit tests (keygen, seal/open, rekey) — no network.
2. Relay service with envelope tests using two in-process clients.
3. Host/guest integration against the relay with a fake transport.
4. Commands `/xomp-collab start|status|stop`, `/xomp-join <link>`, `/xomp-leave`, each registered only after its behavioral tests.
5. Docs rows and a threat-model review before any release.

## Open questions

- Should `guest.message` require host-side confirmation per message, or is rate-limited steering enough? (v1 default: auto-accept from editors, capped.)
- Export path for history backfill (v2): signed session-file chunk with the room key wrapped per guest.
