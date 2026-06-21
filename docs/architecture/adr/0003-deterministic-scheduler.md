# ADR 0003 — Deterministic debounce/supersede scheduling

**Status:** Accepted (#48)

## Context

`turnIntoDelayableExecution` shared one pending timer and one running kill signal
across all invocations of a wrapped operation. A superseded **delayed** call had
its timer cleared but its promise was never settled — an orphaned promise leaked
on normal rapid editing. Killing a delayed call left its promise pending too. And
a finished job's `finally` could null the kill signal a **newer** job had just
stored, leaving the newer job uncancellable (a race).

## Decision

Rewrite the primitive so each call owns its own timer and canceller, and every
returned promise reaches exactly one terminal state — resolved, failed, or
rejected with a cancellation when superseded or killed. The shared "live"
canceller is identity-checked on cleanup, so a finished job cannot clobber a
newer call's canceller. A synchronous throw from the job factory rejects the
promise instead of leaving it pending.

Because superseded calls now settle (reject) instead of hanging, `Model.render`
and `Model.checkSyntax` gained per-kind sequence guards so a stale call cannot
turn off a UI flag that a newer call is still driving.

## Consequences

- No orphaned/never-settled promises under interleaved edit/cancel.
- The cancel-signal clobber race is eliminated.
- Spinner state is unaffected (validated against the full e2e suite).
