# pi-api

> Multi-session Gateway Server, Dual-Orchestrator Bridge (ZeroClaw & PicoClaw), and Universal Telegram Notifier for Pi Coding Agent.

`pi-api` enables external orchestrators (such as [ZeroClaw](https://github.com/zeroclaw) and [PicoClaw](https://github.com/picoclaw)) to interact with, manage, steer, and dispatch tasks to active [Pi](https://github.com/earendil-works/pi-coding-agent) coding agent sessions over a REST API and WebSocket bridge.

It also features a built-in **Universal Telegram Notifier** that delivers instant task completion reports and bidirectional agent nudges directly to Telegram without requiring additional bots or external relay infrastructure.

---

## Architecture Overview

```text
+-----------------------+     +-----------------------+
|  ZeroClaw (:42617)    |     |  PicoClaw (:18790)    |
+-----------+-----------+     +-----------+-----------+
            |  REST API (POST /sessions/:id/prompt, GET /sessions, etc.)
            v
+-----------------------------------------------------+
|  pi-api Gateway Server (:8765)                      |
|  - Multi-session Manager & Circular Message Buffer  |
|  - Multi-receiver Webhook Hub (ZeroClaw & PicoClaw) |
|  - Universal Telegram Notifier Service              |
+-----------------------------------------------------+
        ^ WebSocket (/ws)                     |
        | (register, prompt dispatch,         | Direct Telegram Bot API (HTTP POST)
        |  telemetry, nudge, completion)      v
+-----------------------+             +-----------------------+
|  Pi Client Extension  |             |  Telegram Bot API     |
|  - runs inside Pi     |             |  (api.telegram.org)   |
|  - nudge_orchestrator |             +-----------------------+
|  - turn-event hooks   |
+-----------------------+
```

1. **Pi Client Extension** (`client/index.ts` / `client/connector.ts`) runs within Pi sessions, maintaining a persistent WebSocket connection to the Gateway Server. It registers session metadata (`sessionId`, `cwd`, `model`) and exposes the `nudge_orchestrator` tool to the agent.
2. **Gateway Server** (`server/server.ts`) tracks active sessions, provides REST endpoints for status queries, prompt submission, real-time steering (`/steer`), and relays messages to the target agent.
3. **Multi-Receiver Webhook Hub** (`server/receiver-discovery.ts`) delivers `pi_task_completed` and `pi_nudge` events concurrently to both ZeroClaw and PicoClaw webhooks with automatic port and token discovery.
4. **Universal Telegram Notifier** (`server/telegram-notifier.ts`) automatically sends formatted HTML notifications to Telegram upon task completion or agent nudges.

---

## Features

- **Multi-Session Management:** Run multiple Pi agent sessions in parallel across different directories or workspaces.
- **Dual-Orchestrator Coordination:** Concurrent webhook delivery to ZeroClaw and PicoClaw without conflicting configurations.
- **Nudge & Steer Protocol:**
  - Coding agents can request human/orchestrator intervention via the `nudge_orchestrator` tool.
  - Orchestrators can dynamically guide running agents in real time via `POST /sessions/:id/steer`.
  - Standalone guard ensures `nudge_orchestrator` only runs during active dispatched tasks.
- **Universal Telegram Notifier:** Direct notifications to Telegram channels or private chats with zero external dependencies.
- **Dynamic Recipient Routing:** Override the target Telegram chat ID per-prompt via `notify_chat_id` or metadata.
- **Zero-Config Auto-Pairing:** Automatically discovers ports and tokens for ZeroClaw, PicoClaw, and Telegram from existing configuration files on the host.

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) (>= 1.0.0)

### Installation

```bash
bun install
```

---

## Running the Gateway Server

To start the standalone Gateway Server:

```bash
bun run start
# or
bun run server/index.ts
```

### Server Configuration

Configuration is automatically discovered or can be set via environment variables:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `8765` | TCP port for the Gateway HTTP & WebSocket server |
| `ZEROCLAW_WEBHOOK_URL` | Auto-discovered (`http://127.0.0.1:<port>/webhook`) | Webhook URL for ZeroClaw |
| `ZEROCLAW_WEBHOOK_TOKEN` | Auto-paired from `~/.pi/agent/pi-api-nudge.json` | Bearer authorization token for ZeroClaw |
| `PICOCLAW_WEBHOOK_URL` | Auto-discovered (`http://127.0.0.1:18790/webhook`) | Webhook URL for PicoClaw gateway |
| `PICOCLAW_WEBHOOK_TOKEN` | Auto-discovered from `~/.picoclaw/config.json` | Authorization token for PicoClaw |
| `TELEGRAM_BOT_TOKEN` | Auto-discovered from `~/.picoclaw/.security.yml` or `~/.pi/agent/telegram-notifier.json` | Telegram Bot token (`123456:ABC...`) |
| `DEFAULT_TELEGRAM_CHAT_ID` | Auto-discovered from `~/.zeroclaw/config.toml` or `~/.picoclaw/config.json` | Default numeric chat ID for Telegram notifications |

---

## Telegram Notifier Configuration

The Universal Telegram Notifier delivers direct alerts to your Telegram whenever an agent finishes a task or calls `nudge_orchestrator`.

### Configuration Storage (`~/.pi/agent/telegram-notifier.json`)

On startup, `pi-api` automatically scans for existing Telegram bot tokens and chat IDs across:
1. `~/.picoclaw/.security.yml` (field `telegram.settings.token`)
2. `~/.picoclaw/config.json` (field `allow_from`)
3. `~/.zeroclaw/config.toml` (field `external_peers`)
4. Environment variables `TELEGRAM_BOT_TOKEN` & `DEFAULT_TELEGRAM_CHAT_ID`

It persists the resolved configuration in `~/.pi/agent/telegram-notifier.json`:

```json
{
  "botToken": "<TELEGRAM_BOT_TOKEN>",
  "defaultChatId": "<TELEGRAM_CHAT_ID>",
  "enabled": true,
  "updatedAt": "2026-11-02T01:45:45.685Z"
}
```

### Per-Prompt Chat ID Override

You can route task notifications to a specific Telegram chat or group by specifying `notify_chat_id` when submitting a prompt:

```bash
curl -X POST http://localhost:8765/sessions/my-session/prompt \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Investigate login latency and report findings",
    "notify_chat_id": "999888777"
  }'
```

Alternatively, pass it in the `metadata` object:
```json
{
  "prompt": "Fix database migration",
  "metadata": {
    "notify_chat_id": "999888777"
  }
}
```

---

## Nudge & Steer Protocol

### Agent Tool: `nudge_orchestrator`

When the client extension runs inside Pi, it injects the `nudge_orchestrator` tool:

- **Purpose:** Allows the coding agent to ask questions, report blockers, or provide progress updates back to the orchestrator mid-task.
- **Safety Guard:** Standalone or inactive agents cannot invoke this tool; it only activates during an ongoing task dispatched through `pi-api`.
- **Levels:** `info`, `warning`, `question`, `needs_action`.

When invoked, it sends a WebSocket `nudge` message to the Gateway, which broadcasts it to orchestrator webhooks and sends an alert to Telegram with severity badges:
- `ℹ️ INFO`
- `⚠️ WARNING`
- `❓ QUESTION`
- `🚨 NEEDS_ACTION`

### Mid-Turn Steering (`POST /sessions/:id/steer`)

Orchestrators can provide real-time steering instructions to an agent while it is working:

```bash
curl -X POST http://localhost:8765/sessions/my-session/steer \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Focus only on postgres migration files, skip sqlite"
  }'
```

---

## Hooking the Client Extension into Pi

### Option 1: Package Extension Configuration

Declare the extension in `package.json`:

```json
{
  "pi": {
    "extensions": [
      "pi-api/client"
    ]
  }
}
```

### Option 2: Direct Extension Loading

Load the extension directly when starting Pi:

```bash
pi -e ./node_modules/pi-api/client/index.ts
```

### Client Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PI_GATEWAY_URL` | `ws://localhost:8765/ws` | Gateway WebSocket endpoint URL |
| `PI_SESSION_ID` | Auto-generated UUID | Explicit session ID identifier |
| `PI_SESSION_ALIAS` | Folder name (basename `cwd`) | Human-readable alias for the session |
| `PI_MODEL` | Pi active model | Overrides the reported model name |

---

## API Reference

### REST Endpoints

#### 1. List Sessions
- **Endpoint:** `GET /sessions`
- **Description:** Returns an array of currently active registered Pi sessions.

#### 2. Get Session Status
- **Endpoint:** `GET /sessions/:id/status`
- **Description:** Returns status and metadata for a session by UUID or alias.

#### 3. Send Prompt
- **Endpoint:** `POST /sessions/:id/prompt`
- **Query Parameters:** `wait=true` (blocks until completion; default `false` for async 202 Accepted).
- **Request Body:**
  ```json
  {
    "prompt": "Run unit tests and fix any failures",
    "webhookUrl": "https://orchestrator.internal/webhook",
    "taskId": "task-xyz-789",
    "notify_chat_id": "123456789",
    "metadata": {
      "project": "core-backend"
    }
  }
  ```

#### 4. Steer Session
- **Endpoint:** `POST /sessions/:id/steer`
- **Request Body:**
  ```json
  {
    "message": "Please make sure backward compatibility is preserved"
  }
  ```

#### 5. Send Orchestrator Nudge
- **Endpoint:** `POST /sessions/:id/nudge`
- **Request Body:**
  ```json
  {
    "taskId": "task-xyz-789",
    "message": "Database backup completed, you may proceed with migrations",
    "level": "info"
  }
  ```

#### 6. Get Message History
- **Endpoint:** `GET /sessions/:id/messages?limit=20`
- **Description:** Returns recent conversational turn history (prompts and assistant responses) from the circular ring buffer.

---

## WebSocket Protocol (`/ws`)

### Client to Server
- `register`: `{ type: "register", sessionId, cwd, model }`
- `status_update`: `{ type: "status_update", sessionId, state, activeTool }`
- `task_completed`: `{ type: "task_completed", sessionId, taskId, summary, completedAt }`
- `nudge`: `{ type: "nudge", sessionId, taskId, message, level, data }`
- `pong`: `{ type: "pong" }`

### Server to Client
- `prompt`: `{ type: "prompt", taskId, prompt }`
- `steer`: `{ type: "steer", message }`
- `interrupt`: `{ type: "interrupt" }`
- `ping`: `{ type: "ping" }`

---

## Testing

Run unit tests, client connector tests, and end-to-end integration tests:

```bash
# Run all tests
bun test

# Run individual test suites
bun run test:server
bun run test:client
bun run test:e2e
bun test test/telegram-notifier.test.ts
bun test test/nudge-steer.test.ts
```

All 39 unit and integration tests verify the end-to-end functionality across dual webhooks, Telegram direct alerts, and nudge-steer flows.

---

## License

MIT
