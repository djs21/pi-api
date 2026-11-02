# Shared Domain DOX

## Purpose

Owns common TypeScript types, protocol specifications, WebSocket message schemas, and REST request/response contracts shared between server, client, and external orchestrators.

## Ownership

- `shared/protocol.ts`: Protocol definitions, message unions (`ClientMessage`, `ServerMessage`), session state representations, and webhook payload structures.

## Local Contracts

- All WebSocket messages must have a discriminant `type` field.
- `ClientMessage` encompasses `register`, `status_update`, `task_completed`, `nudge`, and `pong`.
- `ServerMessage` encompasses `prompt`, `steer`, `interrupt`, and `ping`.
- `PostPromptRequest` must support optional `webhookUrl`, `webhookHeaders`, `taskId`, `notifyChatId`, `notify_chat_id`, and `metadata`.
- Backward compatibility: Existing fields must not be removed or renamed without version negotiation.

## Work Guidance

- Keep shared types dependency-free (pure TypeScript declarations).
- When adding new message types, update both server dispatchers and client listeners simultaneously.
- Maintain field name flexibility where external orchestrators use snake_case (`notify_chat_id`) while internal TypeScript conventions use camelCase (`notifyChatId`).

## Verification

Type check protocol across all consumers:

```bash
bun test
```

## Child DOX Index

None.
