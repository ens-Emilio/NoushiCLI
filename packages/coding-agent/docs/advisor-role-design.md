# Advisor Role Design — Second-Model Runtime

Status: design document for `/xomp-advisor` and `/xomp-prewalk`. No code implements this yet; both commands stay unregistered until a second-model runtime role exists in `AgentSession`. This document fixes the lifecycle and isolation contracts first.

## Problem

OMP's `/advisor` runs a second model alongside the primary one: a cheaper/faster model that watches the main transcript and can be asked for a quick take without disturbing the primary loop. `/prewalk` is a related one-shot: a second model pre-reads a large input before the main turn. Both need the same foundation: a second model role with its own runtime lifecycle inside one session.

## Current engine constraints (verified against the pinned baseline)

- `AgentSession` binds exactly one model per session (`modelRuntime`); prompts, history, and the queue all assume one model.
- Provider catalog access is available (used by `/xomp-fast`, `/xomp-extended-context`), so selecting a second model per call is possible.
- Cost tracking is per-session (`setSessionCostLimit`); a second model needs its own metering to avoid double-counting under the goal budget.

## Design

### Role lifecycle

- The advisor role is created per session, lazily: `AdvisorRole` exists only while enabled.
- State machine: `off → starting → ready → busy | error`, back to `ready` after each answer; `off` disposes the role. Persisted as a `noushi.advisor-config` custom entry (`{ model, autoEngage, status }`), so reload restores config but not in-flight state.
- Config: model id (validated against the catalog at set time), optional system-prompt override, `autoEngage` off by default (advisor only speaks when asked).

### Isolation contracts

1. **Separate transcript**: the advisor keeps its own message list, seeded with a *projection* of the main transcript (system prompt + last N assistant/user/toolResult messages, redacted by the same secret rules as `tool.event` in the collab draft). The advisor never writes to the main transcript directly.
2. **Separate metering**: advisor usage accumulates under its own counter; `/xomp-advisor status` reports it. Goal cost limits apply to the primary model only unless the user opts in with `budget include-advisor`.
3. **No tool execution**: the advisor role has zero tools in v1 — it is text-in/text-out. Tool access is a later decision with its own permission review.
4. **No steering**: the advisor cannot enqueue or trigger turns. Its output reaches the main transcript only via an explicit user action (insert as a note) or when `autoEngage` surfaces it as a prefixed context note.

### Commands (registered only after implementation)

- `/xomp-advisor on <model>` / `off` / `status` / `ask <prompt>` / `dump [raw]` / `configure <key> <value>`.
- `/xomp-prewalk <input>`: one-shot — spawns a temporary advisor role, feeds the input, returns the answer, disposes. Shares the same role machinery with no persistent state.
- Every subcommand reports honest unavailability while the role machinery is unimplemented.

### Concurrency rules

- Advisor requests run only while the main session is idle (`isIdle()`), avoiding mid-turn transcript projection races.
- One in-flight advisor request; new asks queue or refuse (refuse is the v1 default, with an explicit queue flag later).

## Verification gate

- Role state-machine tests (off→ready→busy→ready→off, error recovery).
- Projection redaction tests (secrets never reach the advisor transcript).
- Metering tests (advisor usage counted separately, goal budget unaffected by default).
- Honest unavailability for every subcommand until the role ships.

## Open questions

- Does `autoEngage` run the advisor on every assistant turn completion (cost!) or on explicit triggers only? (v1 default: explicit triggers only.)
- Should `/xomp-prewalk` results be cacheable per input hash? (v1: no cache.)
