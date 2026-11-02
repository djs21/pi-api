# Client Domain DOX

## Purpose

Owns the Pi Client Extension and WebSocket bridge client that executes within active Pi coding agent processes, hooks into agent turn lifecycle events, reports status transitions, and injects the `nudge_orchestrator` tool.

## Ownership

- `client/index.ts`: Pi extension entry point registering lifecycle event handlers (`turn_start`, `turn_end`, `tool_call`, `agent_settled`), WebSocket bridge lifecycle, and the `nudge_orchestrator` custom tool.
- `client/connector.ts`: `PiBridgeClient` WebSocket connection manager, status publisher (`idle`, `thinking`, `executing_tool`), reconnection loop, prompt injection, and task completion dispatcher.
- `client/*.test.ts`: Unit tests for client extension and connector.

## Local Contracts

- Must connect to Gateway Server via WebSocket on `PI_GATEWAY_URL` or `ws://localhost:8765/ws`.
- Must register session upon connect with `sessionId`, `cwd`, and `model`.
- Tool `nudge_orchestrator` must ONLY execute when the agent is actively working on a task dispatched via `pi-api` (must reject when standalone or idle).
- Prompt handling must be defensive: ignore empty, whitespace, or undefined prompts without crashing.
- On `agent_settled`, if a task was active, the client must automatically publish `task_completed` with the latest turn output summary.

## Work Guidance

- Ensure extension hooks remain compatible with Pi's `@earendil-works/pi-coding-agent` extension API.
- Keep WebSocket reconnection resilient with exponential backoff so agent processes survive gateway restarts.
- Avoid polluting the main Pi agent context with raw telemetry noise.

## Verification

Run client unit tests:

```bash
bun test client/connector.test.ts
bun test client/index.test.ts
```

## Child DOX Index

None.
