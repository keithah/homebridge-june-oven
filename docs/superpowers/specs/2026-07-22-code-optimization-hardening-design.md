# Code Optimization and Hardening Design

**Date:** 2026-07-22
**Status:** Approved for implementation

## Goal

Reduce avoidable network, timer, and stream-resource work while making the
camera and pairing lifecycles explicit enough to prevent races. Preserve the
June wire contract and Homebridge behavior.

## Design

- Extend HTTP request ownership through response-body consumption. Shared
  response helpers will enforce size limits and cancel unread error bodies.
- Give camera frame downloads one source-level cache and in-flight request so
  snapshots and live sessions share immutable still bytes. Keep stream teardown
  idempotent and settle a pending HomeKit start exactly once.
- Replace pairing's deadline-as-liveness sentinel with explicit cancellation
  ownership and listener checks so destroyed sessions cannot create eviction
  timers or publish terminal state after removal.
- Add bounded, jittered reconnect/startup retry scheduling and clear command
  acknowledgement timers when commands settle.
- Make the UI pairing poll self-scheduling, remove its duplicate timeout helper,
  and retain the existing configuration behavior.
- Remove proven dead dependencies/exports and redundant release verification,
  while retaining small bounded collection operations whose simpler form is
  clearer.

## Verification

Each behavior change gets a focused regression test. The final gate is the full
Vitest suite, TypeScript type-check, production build, diff check, and the
GitHub PR checks after pushing.
