# Test Domain DOX

## Purpose

Owns cross-cutting end-to-end integration test harnesses, multi-receiver dispatch validation, nudge-steer behavior verification, and mock Telegram Bot API test servers.

## Ownership

- `test/e2e.test.ts`: End-to-end integration test covering gateway startup, mock webhook delivery, WebSocket registration, prompt execution, and lifecycle completion.
- `test/nudge-steer.test.ts`: Integration test suite for dual-orchestrator webhook dispatch, `nudge_orchestrator` tool guards, REST `/steer`, and REST `/nudge`.
- `test/telegram-notifier.test.ts`: Integration tests for Telegram message formatting, direct HTTP POST delivery against a mock Telegram API server, event triggers, and chat ID overrides.

## Local Contracts

- All tests must use ephemeral ports (`port: 0`) to prevent port collision during concurrent test runs.
- External HTTP endpoints (`api.telegram.org`, external webhooks) must be mocked or intercepted hermetically during testing.
- Tests must clean up running servers, timers, and WebSockets in `afterEach` hooks.

## Work Guidance

- Use Bun's native test runner (`bun:test`).
- Isolate test environment variables by cleaning up `process.env` modifications in `afterEach`.
- Assert both success paths and error fallback paths (e.g., unreachable webhook receiver, offline Telegram network).

## Verification

Run integration test suites:

```bash
bun test test/e2e.test.ts
bun test test/nudge-steer.test.ts
bun test test/telegram-notifier.test.ts
```

## Child DOX Index

None.
