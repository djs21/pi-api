import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createPiExtension, type ExtensionAPI } from "./index";
import type { ClientMessage, ServerMessage } from "../shared/protocol";
import type { ServerWebSocket } from "bun";

describe("Pi Extension (client/index.ts)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let serverWs: ServerWebSocket<unknown> | null = null;
  let receivedClientMessages: ClientMessage[] = [];
  let port: number;

  beforeEach(() => {
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

  afterEach(() => {
    server.stop(true);
  });

  function createMockApi(): {
    api: ExtensionAPI;
    eventHandlers: Map<string, Array<(...args: any[]) => void>>;
    sentUserMessages: string[];
    injectedMessages: string[];
    trigger(event: string, ...args: any[]): void;
  } {
    const eventHandlers = new Map<string, Array<(...args: any[]) => void>>();
    const sentUserMessages: string[] = [];
    const injectedMessages: string[] = [];

    const api: ExtensionAPI = {
      sessionId: "test-ext-sess-1",
      cwd: "/ext/test/path",
      model: { id: "test-model-4" },
      on(event, handler) {
        if (!eventHandlers.has(event)) {
          eventHandlers.set(event, []);
        }
        eventHandlers.get(event)!.push(handler);
        return () => {
          const arr = eventHandlers.get(event);
          if (arr) {
            const idx = arr.indexOf(handler);
            if (idx >= 0) arr.splice(idx, 1);
          }
        };
      },
      sendUserMessage(msg: string) {
        sentUserMessages.push(msg);
      },
      injectMessage(msg: string) {
        injectedMessages.push(msg);
      },
    };

    return {
      api,
      eventHandlers,
      sentUserMessages,
      injectedMessages,
      trigger(event: string, ...args: any[]) {
        const handlers = eventHandlers.get(event) || [];
        for (const handler of handlers) {
          handler(...args);
        }
      },
    };
  }

  it("hooks into turn_start, tool_call, and turn_end to publish telemetry", async () => {
    const mock = createMockApi();
    const extension = createPiExtension({
      gatewayUrl: `ws://localhost:${port}/ws`,
    });

    const client = extension(mock.api);
    await new Promise((r) => setTimeout(r, 60));

    expect(receivedClientMessages.length).toBeGreaterThanOrEqual(1);
    expect(receivedClientMessages[0].type).toBe("register");

    // Trigger turn_start -> state: thinking
    mock.trigger("turn_start");
    await new Promise((r) => setTimeout(r, 30));

    // Trigger tool_call -> state: executing_tool
    mock.trigger("tool_call", { toolName: "read_file" });
    await new Promise((r) => setTimeout(r, 30));

    // Trigger turn_end -> state: idle
    mock.trigger("turn_end");
    await new Promise((r) => setTimeout(r, 30));

    const statusUpdates = receivedClientMessages.filter(
      (m) => m.type === "status_update"
    );
    expect(statusUpdates.length).toBe(3);
    expect(statusUpdates[0]).toEqual({
      type: "status_update",
      sessionId: "test-ext-sess-1",
      state: "thinking",
      activeTool: undefined,
    });
    expect(statusUpdates[1]).toEqual({
      type: "status_update",
      sessionId: "test-ext-sess-1",
      state: "executing_tool",
      activeTool: "read_file",
    });
    expect(statusUpdates[2]).toEqual({
      type: "status_update",
      sessionId: "test-ext-sess-1",
      state: "idle",
      activeTool: undefined,
    });

    client.disconnect();
  });

  it("injects incoming prompts into Pi session via sendUserMessage and notifies task completion on agent_settled", async () => {
    const mock = createMockApi();
    const extension = createPiExtension({
      gatewayUrl: `ws://localhost:${port}/ws`,
    });

    const client = extension(mock.api);
    await new Promise((r) => setTimeout(r, 60));

    // Server sends prompt
    expect(serverWs).not.toBeNull();
    const promptMsg: ServerMessage = {
      type: "prompt",
      taskId: "task-abc",
      prompt: "Implement caching layer",
    };
    serverWs?.send(JSON.stringify(promptMsg));

    await new Promise((r) => setTimeout(r, 50));

    expect(mock.sentUserMessages).toContain("Implement caching layer");

    // Agent finishes task
    mock.trigger("agent_settled");
    await new Promise((r) => setTimeout(r, 50));

    const taskCompleted = receivedClientMessages.find(
      (m) => m.type === "task_completed"
    );
    expect(taskCompleted).toBeDefined();
    if (taskCompleted && taskCompleted.type === "task_completed") {
      expect(taskCompleted.taskId).toBe("task-abc");
      expect(taskCompleted.sessionId).toBe("test-ext-sess-1");
    }

    client.disconnect();
  });

  it("falls back to injectMessage if sendUserMessage is not available", async () => {
    const mock = createMockApi();
    delete (mock.api as any).sendUserMessage;

    const extension = createPiExtension({
      gatewayUrl: `ws://localhost:${port}/ws`,
    });

    const client = extension(mock.api);
    await new Promise((r) => setTimeout(r, 60));

    const promptMsg: ServerMessage = {
      type: "prompt",
      taskId: "task-fallback",
      prompt: "Fallback prompt message",
    };
    serverWs?.send(JSON.stringify(promptMsg));

    await new Promise((r) => setTimeout(r, 50));

    expect(mock.injectedMessages).toContain("Fallback prompt message");

    client.disconnect();
  });
});
