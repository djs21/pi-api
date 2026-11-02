# Server Domain DOX

## Purpose

Owns the standalone HTTP REST Gateway, WebSocket session hub, multi-receiver orchestrator webhook dispatch (ZeroClaw & PicoClaw), and the Universal Telegram Notifier service.

## Ownership

- `server/index.ts`: Server process entry point and CLI runner.
- `server/server.ts`: HTTP request routing, WebSocket lifecycle, session tracking, circular message buffer, prompt queueing, and steer/nudge handling.
- `server/receiver-discovery.ts`: Multi-orchestrator discovery and concurrent webhook dispatch for ZeroClaw (`:42617`) and PicoClaw (`:18790`).
- `server/zeroclaw-discovery.ts`: ZeroClaw pairing code extraction, token exchange, and persistence to `~/.pi/agent/pi-api-nudge.json`.
- `server/telegram-config.ts`: Discovery and persistence of Telegram bot token and default chat ID to `~/.pi/agent/telegram-notifier.json`.
- `server/telegram-notifier.ts`: Direct HTTP POST notifier to Telegram Bot API (`https://api.telegram.org`) with HTML formatted alerts.
- `server/*.test.ts`: Unit tests for server modules.

## Local Contracts

- Server must listen on `process.env.PORT` or default to `8765`.
- WebSocket endpoint `/ws` must handle `register`, `status_update`, `task_completed`, `nudge`, and `pong`.
- Webhooks must be dispatched concurrently to all configured orchestrators (ZeroClaw & PicoClaw) without blocking the primary event loop.
- Telegram notifications must fail silently without throwing or crashing the gateway server if the network or Telegram API is unreachable.
- Task completion and nudge events must honor `notify_chat_id` overrides specified in prompt submissions.
- Persisted credential files (`~/.pi/agent/telegram-notifier.json`, `~/.pi/agent/pi-api-nudge.json`) must be written with mode `0600`; bot tokens and Bearer tokens must never appear in logs or docs.

## Work Guidance

- Keep server routes minimal and declarative; avoid heavy business logic inside route handlers.
- When adding new external orchestrators, register their discovery and webhook patterns in `receiver-discovery.ts`.
- Prefer Bun's native HTTP/WebSocket APIs (`Bun.serve`).
- Avoid blocking I/O on disk operations during request handling; cache discovery tokens in memory when appropriate.

## Verification

Run server unit tests:

```bash
bun test server/server.test.ts
bun test server/zeroclaw-discovery.test.ts
bun test server/telegram-config.test.ts
```

## Child DOX Index

None.
