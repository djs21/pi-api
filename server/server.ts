import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import { readPersistedNudgeConfig } from "./zeroclaw-discovery";
import { dispatchWebhookEvent } from "./receiver-discovery";
import { autoInitTelegramNotifierConfig } from "./telegram-config";
import {
  sendTelegramNotification,
  formatTelegramNotification,
} from "./telegram-notifier";
import type {
  SessionInfo,
  ClientMessage,
  ServerMessage,
  SessionMessage,
  PostPromptRequest,
  PostPromptResponse,
  PostPromptSyncResponse,
  GetMessagesResponse,
  ZeroClawWebhookPayload,
  WebhookEventPayload,
  PostSteerRequest,
  PostSteerResponse,
  PostNudgeRequest,
  PostNudgeResponse,
} from "../shared/protocol";

interface SessionEntry {
  info: SessionInfo;
  ws: ServerWebSocket<WebSocketData>;
}

interface WebSocketData {
  sessionId?: string;
}

interface TaskWebhookConfig {
  url?: string;
  headers?: Record<string, string>;
  notifyChatId?: string;
}

export function createServer(options: { port?: number } = {}) {
  // Ensure Telegram config in ~/.pi/agent/ is initialized if discovery finds tokens
  autoInitTelegramNotifierConfig();

  const sessions = new Map<string, SessionEntry>();
  const taskWebhooks = new Map<string, TaskWebhookConfig>();
  const sessionMessages = new Map<string, SessionMessage[]>();
  const MAX_MESSAGES_PER_SESSION = 50;

  const taskResolvers = new Map<
    string,
    (res: { status: "completed"; output: string; completedAt: string }) => void
  >();

  function addSessionMessage(sessionId: string, msg: SessionMessage): void {
    let list = sessionMessages.get(sessionId);
    if (!list) {
      list = [];
      sessionMessages.set(sessionId, list);
    }
    list.push(msg);
    if (list.length > MAX_MESSAGES_PER_SESSION) {
      list.shift();
    }
  }

  const server = Bun.serve<WebSocketData>({
    port: options.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 8765),
    fetch(req, server) {
      const url = new URL(req.url);

      const findSession = (identifier: string): SessionEntry | undefined => {
        const decoded = decodeURIComponent(identifier);
        if (sessions.has(decoded)) {
          return sessions.get(decoded);
        }
        for (const entry of sessions.values()) {
          if (entry.info.alias === decoded) {
            return entry;
          }
        }
        return undefined;
      };

      // WebSocket endpoint
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req, {
          data: {},
        });
        if (upgraded) {
          return undefined;
        }
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // REST: GET / or GET /help
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/help")) {
        return Response.json({
          name: "pi-api Gateway",
          description: "Multi-session Gateway Server bridging ZeroClaw and Pi coding agent sessions",
          version: "1.0.0",
          endpoints: {
            "GET /help": {
              description: "Show this help and interactive API documentation",
            },
            "GET /sessions": {
              description: "List all connected Pi agent sessions with their active states",
              response: "Array<SessionInfo>",
            },
            "GET /sessions/:id/status": {
              description: "Get real-time status and metadata of a specific Pi session",
              params: { id: "Session identifier" },
              response: "SessionInfo",
            },
            "GET /sessions/:id/messages": {
              description: "Get recent conversational messages and outputs for a session",
              params: { id: "Session identifier (UUID or alias)" },
              query_params: { limit: "Number of messages to retrieve (default: 20, max: 100)" },
              response: "GetMessagesResponse",
            },
            "POST /sessions/:id/prompt": {
              description: "Dispatch a prompt to a Pi session. Append ?wait=true to wait synchronously for response.",
              params: { id: "Session identifier" },
              query_params: { wait: "Boolean: true to block until response is completed (Optional)" },
              request_body: {
                prompt: "String: instructions/task for Pi (Required)",
                taskId: "String: custom tracking ID (Optional, auto-generated if omitted)",
                webhookUrl: "String: URL to notify via HTTP POST when Pi finishes (Optional)",
              },
              response: {
                async_mode: { accepted: true, sessionId: "string", taskId: "string", status: "queued" },
                sync_mode: { status: "completed", sessionId: "string", taskId: "string", output: "string", completedAt: "string" },
              },
            },
            "WS /ws": {
              description: "WebSocket connection endpoint used by Pi Client Extension",
            },
          },
          zeroclaw_workflow: {
            step_1: "Call GET /sessions to discover active Pi sessions and their working directories (cwd).",
            step_2: "Call POST /sessions/:id/prompt with your prompt and your webhookUrl.",
            step_3: "Receive 202 Accepted immediately. ZeroClaw can return to chat without blocking.",
            step_4: "Gateway dispatches HTTP POST { event: 'pi_task_completed', sessionId, taskId, summary } to your webhook when Pi finishes.",
          },
        });
      }

      // REST: GET /sessions
      if (req.method === "GET" && url.pathname === "/sessions") {
        const sessionList: SessionInfo[] = Array.from(sessions.values()).map(
          (entry) => entry.info
        );
        return Response.json(sessionList);
      }

      // REST: GET /sessions/:id/status
      const statusMatch = url.pathname.match(/^\/sessions\/([^/]+)\/status$/);
      if (req.method === "GET" && statusMatch) {
        const entry = findSession(statusMatch[1]);
        if (!entry) {
          return new Response(JSON.stringify({ error: "Session not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        return Response.json(entry.info);
      }

      // REST: GET /sessions/:id/messages
      const messagesMatch = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
      if (req.method === "GET" && messagesMatch) {
        const entry = findSession(messagesMatch[1]);
        if (!entry) {
          return new Response(JSON.stringify({ error: "Session not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        const limitParam = parseInt(url.searchParams.get("limit") || "20", 10);
        const limit = Math.min(Math.max(isNaN(limitParam) ? 20 : limitParam, 1), 100);

        const allMsgs = sessionMessages.get(entry.info.id) || [];
        const sliced = allMsgs.slice(-limit);

        const responsePayload: GetMessagesResponse = {
          sessionId: entry.info.id,
          alias: entry.info.alias,
          total: allMsgs.length,
          messages: sliced,
        };
        return Response.json(responsePayload);
      }

      // REST: POST /sessions/:id/steer
      const steerMatch = url.pathname.match(/^\/sessions\/([^/]+)\/steer$/);
      if (req.method === "POST" && steerMatch) {
        const entry = findSession(steerMatch[1]);
        if (!entry) {
          return new Response(JSON.stringify({ error: "Session not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        return (async () => {
          let body: PostSteerRequest;
          try {
            body = (await req.json()) as PostSteerRequest;
          } catch {
            return new Response(JSON.stringify({ error: "Invalid JSON" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          const steerInstruction = body.instruction || body.message;
          if (
            !steerInstruction ||
            typeof steerInstruction !== "string" ||
            !steerInstruction.trim()
          ) {
            return new Response(
              JSON.stringify({ error: "instruction is required" }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              }
            );
          }

          const serverMsg: ServerMessage = {
            type: "steer",
            sessionId: entry.info.id,
            instruction: steerInstruction,
            message: steerInstruction,
            targetTaskId: body.targetTaskId,
          };

          addSessionMessage(entry.info.id, {
            id: `msg-${Date.now()}-${randomUUID().slice(0, 8)}`,
            sessionId: entry.info.id,
            role: "user",
            text: `[STEER] ${steerInstruction}`,
            taskId: body.targetTaskId,
            timestamp: new Date().toISOString(),
          });

          entry.ws.send(JSON.stringify(serverMsg));
          entry.info.lastSeen = new Date().toISOString();

          const responsePayload: PostSteerResponse = {
            accepted: true,
            sessionId: entry.info.id,
            status: "delivered",
            targetTaskId: body.targetTaskId,
          };

          return Response.json(responsePayload, { status: 200 });
        })();
      }

      // REST: POST /sessions/:id/nudge
      const nudgeMatch = url.pathname.match(/^\/sessions\/([^/]+)\/nudge$/);
      if (req.method === "POST" && nudgeMatch) {
        const entry = findSession(nudgeMatch[1]);
        if (!entry) {
          return new Response(JSON.stringify({ error: "Session not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        return (async () => {
          let body: PostNudgeRequest;
          try {
            body = (await req.json()) as PostNudgeRequest;
          } catch {
            return new Response(JSON.stringify({ error: "Invalid JSON" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          if (
            !body.message ||
            typeof body.message !== "string" ||
            !body.message.trim()
          ) {
            return new Response(JSON.stringify({ error: "message is required" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          const eventPayload: WebhookEventPayload = {
            event: "pi_nudge",
            source: "pi-api",
            sessionId: entry.info.id,
            taskId: body.taskId || "",
            message: body.message,
            summary: body.message,
            level: body.level || "info",
            metadata: body.data,
            completedAt: new Date().toISOString(),
          };

          addSessionMessage(entry.info.id, {
            id: `msg-${Date.now()}-${randomUUID().slice(0, 8)}`,
            sessionId: entry.info.id,
            role: "system",
            text: `[NUDGE:${body.level || "info"}] ${body.message}`,
            taskId: body.taskId,
            timestamp: new Date().toISOString(),
          });

          const taskWebhook = body.taskId
            ? taskWebhooks.get(body.taskId)
            : undefined;
          dispatchWebhookEvent(
            eventPayload,
            taskWebhook?.url,
            taskWebhook?.headers
          );

          const responsePayload: PostNudgeResponse = {
            accepted: true,
            sessionId: entry.info.id,
            taskId: body.taskId,
            status: "queued",
          };

          return Response.json(responsePayload, { status: 202 });
        })();
      }

      // REST: POST /sessions/:id/prompt
      const promptMatch = url.pathname.match(/^\/sessions\/([^/]+)\/prompt$/);
      if (req.method === "POST" && promptMatch) {
        const entry = findSession(promptMatch[1]);
        if (!entry) {
          return new Response(JSON.stringify({ error: "Session not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        return (async () => {
          let body: PostPromptRequest;
          try {
            body = (await req.json()) as PostPromptRequest;
          } catch {
            return new Response(JSON.stringify({ error: "Invalid JSON" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          const taskId = body.taskId || randomUUID();

          const targetNotifyChatId =
            body.notifyChatId ||
            body.notify_chat_id ||
            body.metadata?.notify_chat_id ||
            body.metadata?.notifyChatId;

          if (body.webhookUrl || targetNotifyChatId) {
            taskWebhooks.set(taskId, {
              url: body.webhookUrl,
              headers: body.webhookHeaders,
              notifyChatId: targetNotifyChatId,
            });
          }

          const isWait = url.searchParams.get("wait") === "true";
          let completionPromise: Promise<{ status: "completed" | "timeout"; output: string; completedAt?: string }> | null = null;

          if (isWait) {
            const timeoutMs = 60_000;
            completionPromise = new Promise((resolve) => {
              const timer = setTimeout(() => {
                taskResolvers.delete(taskId);
                resolve({ status: "timeout", output: "Task execution timed out after 60s" });
              }, timeoutMs);

              taskResolvers.set(taskId, (res) => {
                clearTimeout(timer);
                resolve(res);
              });
            });
          }

          const serverMsg: ServerMessage = {
            type: "prompt",
            taskId,
            prompt: body.prompt,
          };

          addSessionMessage(entry.info.id, {
            id: `msg-${Date.now()}-${randomUUID().slice(0, 8)}`,
            sessionId: entry.info.id,
            role: "user",
            text: body.prompt,
            taskId,
            timestamp: new Date().toISOString(),
          });

          entry.ws.send(JSON.stringify(serverMsg));
          entry.info.state = "thinking";
          entry.info.lastSeen = new Date().toISOString();

          if (isWait && completionPromise) {
            const outcome = await completionPromise;
            const syncPayload: PostPromptSyncResponse = {
              status: outcome.status,
              sessionId: entry.info.id,
              taskId,
              output: outcome.output,
              completedAt: outcome.completedAt,
            };
            return Response.json(syncPayload, {
              status: outcome.status === "timeout" ? 504 : 200,
            });
          }

          const responsePayload: PostPromptResponse = {
            accepted: true,
            sessionId: entry.info.id,
            taskId,
            status: "queued",
          };

          return new Response(JSON.stringify(responsePayload), {
            status: 202,
            headers: { "Content-Type": "application/json" },
          });
        })();
      }

      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(
            typeof raw === "string" ? raw : new TextDecoder().decode(raw)
          ) as ClientMessage;
        } catch {
          return;
        }

        const now = new Date().toISOString();

        switch (msg.type) {
          case "register": {
            ws.data.sessionId = msg.sessionId;
            const info: SessionInfo = {
              id: msg.sessionId,
              alias: msg.alias,
              cwd: msg.cwd,
              model: msg.model,
              state: "idle",
              connectedAt: now,
              lastSeen: now,
            };
            sessions.set(msg.sessionId, { info, ws });
            break;
          }
          case "status_update": {
            const entry = sessions.get(msg.sessionId);
            if (entry) {
              entry.info.state = msg.state;
              entry.info.activeTool = msg.activeTool;
              entry.info.lastSeen = now;
            }
            break;
          }
          case "task_completed": {
            const entry = sessions.get(msg.sessionId);
            if (entry) {
              entry.info.state = "idle";
              entry.info.activeTool = undefined;
              entry.info.lastSeen = now;
            }

            const fullOutput = msg.output || msg.summary || "Task finished.";

            addSessionMessage(msg.sessionId, {
              id: `msg-${Date.now()}-${randomUUID().slice(0, 8)}`,
              sessionId: msg.sessionId,
              role: "assistant",
              text: fullOutput,
              taskId: msg.taskId,
              timestamp: msg.completedAt || now,
            });

            if (msg.taskId) {
              const resolver = taskResolvers.get(msg.taskId);
              if (resolver) {
                resolver({
                  status: "completed",
                  output: fullOutput,
                  completedAt: msg.completedAt || now,
                });
                taskResolvers.delete(msg.taskId);
              }
            }

            const webhookConfig = msg.taskId ? taskWebhooks.get(msg.taskId) : undefined;
            const sessionIdentifier = entry?.info.alias || msg.sessionId;
            const summaryText = msg.summary || "Agent finished all turns.";

            const payload: WebhookEventPayload = {
              event: "pi_task_completed",
              source: "pi-api",
              sessionId: msg.sessionId,
              taskId: msg.taskId || "",
              message: `[pi-api] Task '${msg.taskId || "default"}' completed on session '${sessionIdentifier}': ${summaryText}`,
              summary: summaryText,
              output: fullOutput,
              completedAt: msg.completedAt || now,
            };

            dispatchWebhookEvent(
              payload,
              webhookConfig?.url,
              webhookConfig?.headers
            );

            // Direct Telegram notification
            sendTelegramNotification({
              text: formatTelegramNotification({
                event: "task_completed",
                sessionId: msg.sessionId,
                taskId: msg.taskId || "",
                summary: summaryText,
              }),
              chatId: webhookConfig?.notifyChatId,
            });

            if (msg.taskId) {
              taskWebhooks.delete(msg.taskId);
            }
            break;
          }
          case "nudge": {
            const now = new Date().toISOString();
            const entry = sessions.get(msg.sessionId);
            const sessionIdentifier = entry?.info.alias || msg.sessionId;

            addSessionMessage(msg.sessionId, {
              id: `msg-${Date.now()}-${randomUUID().slice(0, 8)}`,
              sessionId: msg.sessionId,
              role: "assistant",
              text: `[NUDGE:${msg.level || "info"}] ${msg.message}`,
              taskId: msg.taskId,
              timestamp: msg.timestamp || now,
            });

            const webhookConfig = msg.taskId
              ? taskWebhooks.get(msg.taskId)
              : undefined;

            const payload: WebhookEventPayload = {
              event: "pi_nudge",
              source: "pi-api",
              sessionId: msg.sessionId,
              taskId: msg.taskId,
              message: `[pi-api] Nudge from session '${sessionIdentifier}' (task: '${msg.taskId}'): ${msg.message}`,
              summary: msg.message,
              level: msg.level || "info",
              metadata: msg.data,
              completedAt: msg.timestamp || now,
            };

            dispatchWebhookEvent(
              payload,
              webhookConfig?.url,
              webhookConfig?.headers
            );

            // Direct Telegram notification for nudge
            sendTelegramNotification({
              text: formatTelegramNotification({
                event: "nudge",
                sessionId: msg.sessionId,
                taskId: msg.taskId,
                message: msg.message,
                level: msg.level,
              }),
              chatId: webhookConfig?.notifyChatId,
            });
            break;
          }
          case "pong": {
            if (ws.data.sessionId) {
              const entry = sessions.get(ws.data.sessionId);
              if (entry) {
                entry.info.lastSeen = now;
              }
            }
            break;
          }
        }
      },
      close(ws) {
        if (ws.data.sessionId) {
          sessions.delete(ws.data.sessionId);
        }
      },
    },
  });

  return server;
}
