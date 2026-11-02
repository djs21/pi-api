import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createServer } from "./server";
import type {
  SessionInfo,
  ClientMessage,
  ServerMessage,
  PostPromptResponse,
  ZeroClawWebhookPayload,
} from "../shared/protocol";

describe("Gateway Server", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let wsUrl: string;

  beforeAll(() => {
    server = createServer({ port: 0 });
    baseUrl = `http://localhost:${server.port}`;
    wsUrl = `ws://localhost:${server.port}/ws`;
  });

  afterAll(() => {
    server.stop(true);
  });

  it("GET /help returns interactive API documentation and endpoints guide", async () => {
    const res = await fetch(`${baseUrl}/help`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.name).toBe("pi-api Gateway");
    expect(data.endpoints).toBeDefined();
    expect(data.endpoints["POST /sessions/:id/prompt"]).toBeDefined();
    expect(data.zeroclaw_workflow).toBeDefined();
  });

  it("GET /sessions returns an empty list initially", async () => {
    const res = await fetch(`${baseUrl}/sessions`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as SessionInfo[];
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(0);
  });

  it("WebSocket on /ws registers a session and GET /sessions reflects it", async () => {
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        const regMsg: ClientMessage = {
          type: "register",
          sessionId: "sess-1",
          cwd: "/home/user/project",
          model: "claude-3-opus",
        };
        ws.send(JSON.stringify(regMsg));
      };

      // Wait a moment for server to process registration
      setTimeout(resolve, 50);
      ws.onerror = reject;
    });

    const res = await fetch(`${baseUrl}/sessions`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as SessionInfo[];
    expect(data.length).toBe(1);
    expect(data[0].id).toBe("sess-1");
    expect(data[0].cwd).toBe("/home/user/project");
    expect(data[0].model).toBe("claude-3-opus");
    expect(data[0].state).toBe("idle");
    expect(data[0].connectedAt).toBeDefined();
    expect(data[0].lastSeen).toBeDefined();

    ws.close();
  });

  it("GET /sessions/:id/status returns current session state and metadata", async () => {
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve) => {
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "register",
            sessionId: "sess-status",
            cwd: "/app",
          })
        );
        setTimeout(resolve, 50);
      };
    });

    const res = await fetch(`${baseUrl}/sessions/sess-status/status`);
    expect(res.status).toBe(200);
    const status = (await res.json()) as SessionInfo;
    expect(status.id).toBe("sess-status");
    expect(status.cwd).toBe("/app");
    expect(status.state).toBe("idle");

    const notFound = await fetch(`${baseUrl}/sessions/non-existent/status`);
    expect(notFound.status).toBe(404);

    ws.close();
  });

  it("POST /sessions/:id/prompt dispatches prompt to registered session WebSocket and returns 202", async () => {
    const ws = new WebSocket(wsUrl);

    const receivedMessages: ServerMessage[] = [];

    await new Promise<void>((resolve) => {
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "register",
            sessionId: "sess-prompt",
            cwd: "/workspace",
          })
        );
        setTimeout(resolve, 50);
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data.toString()) as ServerMessage;
        receivedMessages.push(msg);
      };
    });

    const promptRes = await fetch(`${baseUrl}/sessions/sess-prompt/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Fix the build" }),
    });

    expect(promptRes.status).toBe(202);
    const body = (await promptRes.json()) as PostPromptResponse;
    expect(body.accepted).toBe(true);
    expect(body.sessionId).toBe("sess-prompt");
    expect(body.status).toBe("queued");
    expect(typeof body.taskId).toBe("string");

    // Wait for WS message receipt
    await new Promise((r) => setTimeout(r, 50));
    expect(receivedMessages.length).toBeGreaterThanOrEqual(1);
    const promptMsg = receivedMessages.find((m) => m.type === "prompt") as
      | { type: "prompt"; taskId: string; prompt: string }
      | undefined;
    expect(promptMsg).toBeDefined();
    expect(promptMsg?.prompt).toBe("Fix the build");
    expect(promptMsg?.taskId).toBe(body.taskId);

    ws.close();
  });

  it("POST /sessions/:id/prompt on non-existent session returns 404", async () => {
    const res = await fetch(`${baseUrl}/sessions/does-not-exist/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Hello?" }),
    });

    expect(res.status).toBe(404);
  });

  it("dispatches webhook to per-task webhookUrl when task_completed received", async () => {
    const capturedPayloads: ZeroClawWebhookPayload[] = [];
    const mockWebhookServer = Bun.serve({
      port: 0,
      fetch(req) {
        return (async () => {
          const payload = (await req.json()) as ZeroClawWebhookPayload;
          capturedPayloads.push(payload);
          return new Response("OK", { status: 200 });
        })();
      },
    });

    const mockWebhookUrl = `http://localhost:${mockWebhookServer.port}/webhook`;

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => {
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "register",
            sessionId: "sess-webhook",
            cwd: "/webhook-test",
          })
        );
        setTimeout(resolve, 50);
      };
    });

    const promptRes = await fetch(`${baseUrl}/sessions/sess-webhook/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "do work",
        webhookUrl: mockWebhookUrl,
        taskId: "task-42",
      }),
    });
    expect(promptRes.status).toBe(202);

    const completedAt = new Date().toISOString();
    ws.send(
      JSON.stringify({
        type: "task_completed",
        sessionId: "sess-webhook",
        taskId: "task-42",
        summary: "done",
        completedAt,
      })
    );

    // Wait for webhook dispatch
    await new Promise((r) => setTimeout(r, 100));

    expect(capturedPayloads.length).toBe(1);
    expect(capturedPayloads[0]).toEqual({
      event: "pi_task_completed",
      source: "pi-api",
      message: "[pi-api] Task 'task-42' completed on session 'sess-webhook': done",
      sessionId: "sess-webhook",
      taskId: "task-42",
      summary: "done",
      output: "done",
      completedAt,
    });

    ws.close();
    mockWebhookServer.stop(true);
  });

  it("falls back to process.env.ZEROCLAW_WEBHOOK_URL if no per-task webhookUrl supplied", async () => {
    const capturedPayloads: ZeroClawWebhookPayload[] = [];
    const mockWebhookServer = Bun.serve({
      port: 0,
      fetch(req) {
        return (async () => {
          const payload = (await req.json()) as ZeroClawWebhookPayload;
          capturedPayloads.push(payload);
          return new Response("OK", { status: 200 });
        })();
      },
    });

    const originalEnv = process.env.ZEROCLAW_WEBHOOK_URL;
    process.env.ZEROCLAW_WEBHOOK_URL = `http://localhost:${mockWebhookServer.port}/global-webhook`;

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => {
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "register",
            sessionId: "sess-fallback",
            cwd: "/fallback-test",
          })
        );
        setTimeout(resolve, 50);
      };
    });

    const promptRes = await fetch(`${baseUrl}/sessions/sess-fallback/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "do fallback work",
        taskId: "task-env-fallback",
      }),
    });
    expect(promptRes.status).toBe(202);

    const completedAt = new Date().toISOString();
    ws.send(
      JSON.stringify({
        type: "task_completed",
        sessionId: "sess-fallback",
        taskId: "task-env-fallback",
        summary: "fallback completed",
        completedAt,
      })
    );

    // Wait for webhook dispatch
    await new Promise((r) => setTimeout(r, 100));

    expect(capturedPayloads.length).toBe(1);
    expect(capturedPayloads[0]).toEqual({
      event: "pi_task_completed",
      source: "pi-api",
      message: "[pi-api] Task 'task-env-fallback' completed on session 'sess-fallback': fallback completed",
      sessionId: "sess-fallback",
      taskId: "task-env-fallback",
      summary: "fallback completed",
      output: "fallback completed",
      completedAt,
    });

    ws.close();
    mockWebhookServer.stop(true);
    if (originalEnv !== undefined) {
      process.env.ZEROCLAW_WEBHOOK_URL = originalEnv;
    } else {
      delete process.env.ZEROCLAW_WEBHOOK_URL;
    }
  });

  it("stores user and assistant messages in circular buffer and returns them via GET /sessions/:id/messages", async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => {
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "register",
            sessionId: "sess-buffer-test",
            alias: "buffer-alias",
            cwd: "/tmp/buffer",
          })
        );
        resolve();
      };
    });

    await new Promise((r) => setTimeout(r, 50));

    // Send a prompt via REST
    await fetch(`${baseUrl}/sessions/buffer-alias/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Hello Pi, please summarize the codebase.",
        taskId: "task-buf-1",
      }),
    });

    // Simulate agent completion
    ws.send(
      JSON.stringify({
        type: "task_completed",
        sessionId: "sess-buffer-test",
        taskId: "task-buf-1",
        summary: "Summary text",
        output: "Full detailed codebase summary output.",
        completedAt: new Date().toISOString(),
      })
    );

    await new Promise((r) => setTimeout(r, 50));

    // Fetch messages by alias
    const res = await fetch(`${baseUrl}/sessions/buffer-alias/messages?limit=10`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as any;
    expect(data.sessionId).toBe("sess-buffer-test");
    expect(data.alias).toBe("buffer-alias");
    expect(data.total).toBe(2);
    expect(data.messages.length).toBe(2);

    expect(data.messages[0].role).toBe("user");
    expect(data.messages[0].text).toBe("Hello Pi, please summarize the codebase.");
    expect(data.messages[0].taskId).toBe("task-buf-1");

    expect(data.messages[1].role).toBe("assistant");
    expect(data.messages[1].text).toBe("Full detailed codebase summary output.");
    expect(data.messages[1].taskId).toBe("task-buf-1");

    ws.close();
  });

  it("synchronously waits for task completion when POST /sessions/:id/prompt?wait=true is used", async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => {
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "register",
            sessionId: "sess-sync-test",
            alias: "sync-alias",
            cwd: "/tmp/sync",
          })
        );
        resolve();
      };
    });

    await new Promise((r) => setTimeout(r, 50));

    // Listen for incoming prompt and respond with task_completed
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data.toString());
      if (msg.type === "prompt") {
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              type: "task_completed",
              sessionId: "sess-sync-test",
              taskId: msg.taskId,
              summary: "Sync task done",
              output: "Synchronous response received directly from agent!",
              completedAt: new Date().toISOString(),
            })
          );
        }, 30);
      }
    };

    // Dispatch synchronous prompt
    const res = await fetch(`${baseUrl}/sessions/sync-alias/prompt?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Quick sync calculation: 2 + 2",
      }),
    });

    expect(res.status).toBe(200);
    const result = (await res.json()) as any;
    expect(result.status).toBe("completed");
    expect(result.sessionId).toBe("sess-sync-test");
    expect(result.output).toBe("Synchronous response received directly from agent!");

    ws.close();
  });
});
