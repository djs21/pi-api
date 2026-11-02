import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PiBridgeClient } from "./connector";
import type { ClientMessage, ServerMessage } from "../shared/protocol";
import type { ServerWebSocket } from "bun";

describe("PiBridgeClient", () => {
  let server: ReturnType<typeof Bun.serve>;
  let serverWs: ServerWebSocket<unknown> | null = null;
  let receivedClientMessages: ClientMessage[] = [];
  let port: number;

  beforeEach(async () => {
    receivedClientMessages = [];
    serverWs = null;

    server = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) {
          return;
        }
        return new Response("Not a websocket", { status: 400 });
      },
      websocket: {
        open(ws) {
          serverWs = ws;
        },
        message(ws, message) {
          const parsed = JSON.parse(message.toString()) as ClientMessage;
          receivedClientMessages.push(parsed);
        },
        close(ws) {
          if (serverWs === ws) {
            serverWs = null;
          }
        },
      },
    });

    port = server.port;
  });

  afterEach(async () => {
    server.stop(true);
  });

  it("connects to Gateway WebSocket and sends register message upon connect", async () => {
    const client = new PiBridgeClient({
      gatewayUrl: `ws://localhost:${port}/ws`,
      sessionId: "session-abc-123",
      cwd: "/test/workspace",
      model: "claude-3-5-sonnet",
    });

    await client.connect();

    // Give a brief moment for the message to be received by mock server
    await new Promise((r) => setTimeout(r, 50));

    expect(receivedClientMessages.length).toBeGreaterThanOrEqual(1);
    const registerMsg = receivedClientMessages.find((m) => m.type === "register");
    expect(registerMsg).toBeDefined();
    expect(registerMsg).toEqual({
      type: "register",
      sessionId: "session-abc-123",
      cwd: "/test/workspace",
      model: "claude-3-5-sonnet",
    });

    client.disconnect();
  });

  it("handles incoming prompt message by calling a registered prompt callback", async () => {
    let receivedTaskId = "";
    let receivedPrompt = "";

    const client = new PiBridgeClient({
      gatewayUrl: `ws://localhost:${port}/ws`,
      sessionId: "session-prompt-test",
      cwd: "/test/workspace",
    });

    client.onPrompt((taskId, prompt) => {
      receivedTaskId = taskId;
      receivedPrompt = prompt;
    });

    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    expect(serverWs).not.toBeNull();

    const serverMsg: ServerMessage = {
      type: "prompt",
      taskId: "task-999",
      prompt: "Refactor database queries",
    };
    serverWs?.send(JSON.stringify(serverMsg));

    await new Promise((r) => setTimeout(r, 50));

    expect(receivedTaskId).toBe("task-999");
    expect(receivedPrompt).toBe("Refactor database queries");

    client.disconnect();
  });

  it("sends status updates: idle, thinking, executing_tool", async () => {
    const client = new PiBridgeClient({
      gatewayUrl: `ws://localhost:${port}/ws`,
      sessionId: "session-status-test",
      cwd: "/test/workspace",
    });

    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    client.updateStatus("thinking");
    client.updateStatus("executing_tool", "bash");
    client.updateStatus("idle");

    await new Promise((r) => setTimeout(r, 50));

    const statusUpdates = receivedClientMessages.filter(
      (m) => m.type === "status_update"
    );

    expect(statusUpdates.length).toBe(3);
    expect(statusUpdates[0]).toEqual({
      type: "status_update",
      sessionId: "session-status-test",
      state: "thinking",
      activeTool: undefined,
    });
    expect(statusUpdates[1]).toEqual({
      type: "status_update",
      sessionId: "session-status-test",
      state: "executing_tool",
      activeTool: "bash",
    });
    expect(statusUpdates[2]).toEqual({
      type: "status_update",
      sessionId: "session-status-test",
      state: "idle",
      activeTool: undefined,
    });

    client.disconnect();
  });

  it("sends task completion message with taskId, summary, completedAt", async () => {
    const client = new PiBridgeClient({
      gatewayUrl: `ws://localhost:${port}/ws`,
      sessionId: "session-completion-test",
      cwd: "/test/workspace",
    });

    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    const completedAt = new Date().toISOString();
    client.completeTask({
      taskId: "task-555",
      summary: "Implemented user login successfully",
      completedAt,
    });

    await new Promise((r) => setTimeout(r, 50));

    const completionMsg = receivedClientMessages.find(
      (m) => m.type === "task_completed"
    );

    expect(completionMsg).toBeDefined();
    expect(completionMsg).toEqual({
      type: "task_completed",
      sessionId: "session-completion-test",
      taskId: "task-555",
      summary: "Implemented user login successfully",
      completedAt,
    });

    client.disconnect();
  });

  it("responds to server ping with pong message", async () => {
    const client = new PiBridgeClient({
      gatewayUrl: `ws://localhost:${port}/ws`,
      sessionId: "session-ping-test",
      cwd: "/test/workspace",
    });

    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    const pingMsg: ServerMessage = { type: "ping" };
    serverWs?.send(JSON.stringify(pingMsg));

    await new Promise((r) => setTimeout(r, 50));

    const pongMsg = receivedClientMessages.find((m) => m.type === "pong");
    expect(pongMsg).toBeDefined();
    expect(pongMsg).toEqual({ type: "pong" });

    client.disconnect();
  });
});
