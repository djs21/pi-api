import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createServer } from "../server/server";
import { createPiExtension, type ExtensionAPI } from "../client/index";
import { PiBridgeClient } from "../client/connector";
import {
  dispatchWebhookEvent,
  resolveReceivers,
  writePersistedReceivers,
  type ReceiverConfig,
} from "../server/receiver-discovery";
import type {
  ClientMessage,
  ServerMessage,
  WebhookEventPayload,
} from "../shared/protocol";

describe("BEAD-01 to BEAD-06: Dual-Orchestrator Nudge & Steer Protocol", () => {
  let gatewayServer: ReturnType<typeof createServer>;
  let gatewayPort: number;
  let baseUrl: string;
  let wsUrl: string;

  beforeEach(() => {
    gatewayServer = createServer({ port: 0 });
    gatewayPort = gatewayServer.port;
    baseUrl = `http://localhost:${gatewayPort}`;
    wsUrl = `ws://localhost:${gatewayPort}/ws`;
  });

  afterEach(() => {
    gatewayServer.stop(true);
  });

  function createMockApi(sessionId: string = "test-session-1") {
    const eventHandlers = new Map<string, Array<(...args: any[]) => void>>();
    const sentUserMessages: Array<{ message: string; options?: any }> = [];
    const injectedMessages: Array<{ message: string; options?: any }> = [];
    const registeredTools: any[] = [];

    const api: ExtensionAPI = {
      sessionId,
      cwd: "/test/path",
      model: { id: "test-model" },
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
      sendUserMessage(message, options) {
        sentUserMessages.push({ message, options });
      },
      injectMessage(message, options) {
        injectedMessages.push({ message, options });
      },
      registerTool(tool) {
        registeredTools.push(tool);
      },
    };

    return {
      api,
      eventHandlers,
      sentUserMessages,
      injectedMessages,
      registeredTools,
      trigger(event: string, ...args: any[]) {
        const handlers = eventHandlers.get(event) || [];
        for (const handler of handlers) {
          handler(...args);
        }
      },
    };
  }

  it("BEAD-04 Guard: nudge_orchestrator rejects execution when agent is not connected (standalone mode)", async () => {
    const mock = createMockApi("standalone-sess");
    const extension = createPiExtension({
      gatewayUrl: "ws://localhost:99999/dummy", // Will not connect
      sessionId: "standalone-sess",
    });

    extension(mock.api);

    expect(mock.registeredTools.length).toBe(1);
    const nudgeTool = mock.registeredTools[0];
    expect(nudgeTool.name).toBe("nudge_orchestrator");

    // Execute tool while disconnected
    const result = await nudgeTool.execute("call-1", {
      message: "Hello from standalone agent",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("standalone mode");
  });

  it("BEAD-04 Guard: nudge_orchestrator rejects execution when connected but no active pi-api task context", async () => {
    const mock = createMockApi("connected-no-task");
    const extension = createPiExtension({
      gatewayUrl: wsUrl,
      sessionId: "connected-no-task",
    });

    const client = extension(mock.api);
    await new Promise((r) => setTimeout(r, 60));

    expect(client.isConnected()).toBe(true);
    const nudgeTool = mock.registeredTools[0];

    // User types in CLI: trigger input and turn_start (should NOT create active task)
    mock.trigger("input");
    mock.trigger("turn_start");

    const result = await nudgeTool.execute("call-2", {
      message: "Unsolicited nudge attempt",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ONLY available when executing an active task");

    client.disconnect();
  });

  it("BEAD-04 & BEAD-03: nudge_orchestrator succeeds during active task and delivers WS nudge to Gateway", async () => {
    const mock = createMockApi("active-task-sess");
    const extension = createPiExtension({
      gatewayUrl: wsUrl,
      sessionId: "active-task-sess",
    });

    const client = extension(mock.api);
    await new Promise((r) => setTimeout(r, 60));

    // Dispatch prompt from gateway to create active task
    const promptRes = await fetch(`${baseUrl}/sessions/active-task-sess/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Refactor auth module",
        taskId: "task-official-001",
      }),
    });
    expect(promptRes.status).toBe(202);

    // Wait for prompt to arrive at client extension
    await new Promise((r) => setTimeout(r, 60));
    expect(mock.sentUserMessages.length).toBe(1);
    expect(mock.sentUserMessages[0].message).toBe("Refactor auth module");

    // Now execute nudge_orchestrator
    const nudgeTool = mock.registeredTools[0];
    const result = await nudgeTool.execute("call-3", {
      message: "Found migration conflict, proceeding with safe fallback",
      level: "warning",
      data: { file: "auth.ts", line: 42 },
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Nudge successfully sent");
    expect(result.content[0].text).toContain("task-official-001");

    // Verify nudge message is recorded in session history at gateway
    const msgRes = await fetch(`${baseUrl}/sessions/active-task-sess/messages`);
    const msgData = (await msgRes.json()) as any;
    const nudgeEntry = msgData.messages.find((m: any) =>
      m.text.includes("[NUDGE:warning]")
    );
    expect(nudgeEntry).toBeDefined();
    expect(nudgeEntry.text).toContain("Found migration conflict");

    // End turn and verify lifecycle reset
    mock.trigger("agent_settled");
    await new Promise((r) => setTimeout(r, 60));

    // Subsequent nudge attempt after task settled must now be rejected
    const postSettledResult = await nudgeTool.execute("call-4", {
      message: "Post-settled nudge attempt",
    });
    expect(postSettledResult.isError).toBe(true);

    client.disconnect();
  });

  it("BEAD-03 & BEAD-04: Defensive prompt guard ignores undefined or empty prompts without runtime crash", async () => {
    const mock = createMockApi("defensive-prompt-sess");
    const extension = createPiExtension({
      gatewayUrl: wsUrl,
      sessionId: "defensive-prompt-sess",
    });

    const client = extension(mock.api);
    await new Promise((r) => setTimeout(r, 60));

    // Send malformed prompt frame directly over WS client
    (client as any).handleServerMessage(
      JSON.stringify({
        type: "prompt",
        taskId: "bad-task",
        prompt: undefined, // undefined evaluates to null in JSON or missing
      })
    );

    (client as any).handleServerMessage(
      JSON.stringify({
        type: "prompt",
        taskId: "bad-task-2",
        prompt: "   ", // whitespace only
      })
    );

    // No prompts should have been forwarded to Pi runner
    expect(mock.sentUserMessages.length).toBe(0);
    client.disconnect();
  });

  it("BEAD-05: REST POST /sessions/:id/steer delivers steer instruction to active Pi Agent", async () => {
    const mock = createMockApi("steer-sess");
    const extension = createPiExtension({
      gatewayUrl: wsUrl,
      sessionId: "steer-sess",
    });

    const client = extension(mock.api);
    await new Promise((r) => setTimeout(r, 60));

    // Call REST steer endpoint
    const steerRes = await fetch(`${baseUrl}/sessions/steer-sess/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "Stop refactoring auth.ts, switch to session.ts immediately.",
        targetTaskId: "task-002",
      }),
    });

    expect(steerRes.status).toBe(200);
    const steerBody = (await steerRes.json()) as any;
    expect(steerBody.accepted).toBe(true);
    expect(steerBody.status).toBe("delivered");

    // Wait for WebSocket delivery to extension
    await new Promise((r) => setTimeout(r, 60));

    expect(mock.sentUserMessages.length).toBe(1);
    expect(mock.sentUserMessages[0].message).toBe(
      "Stop refactoring auth.ts, switch to session.ts immediately."
    );
    expect(mock.sentUserMessages[0].options).toEqual({ deliverAs: "steer" });

    client.disconnect();
  });

  it("BEAD-05: REST POST /sessions/:id/nudge accepts and records async orchestrator nudge", async () => {
    const mock = createMockApi("nudge-rest-sess");
    const extension = createPiExtension({
      gatewayUrl: wsUrl,
      sessionId: "nudge-rest-sess",
    });

    const client = extension(mock.api);
    await new Promise((r) => setTimeout(r, 60));

    const nudgeRes = await fetch(`${baseUrl}/sessions/nudge-rest-sess/nudge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "External coordinator requests status report",
        level: "question",
      }),
    });

    expect(nudgeRes.status).toBe(202);
    const nudgeBody = (await nudgeRes.json()) as any;
    expect(nudgeBody.accepted).toBe(true);
    expect(nudgeBody.status).toBe("queued");

    // Verify logged into messages
    const msgsRes = await fetch(`${baseUrl}/sessions/nudge-rest-sess/messages`);
    const msgsData = (await msgsRes.json()) as any;
    expect(
      msgsData.messages.some((m: any) =>
        m.text.includes("[NUDGE:question] External coordinator requests status report")
      )
    ).toBe(true);

    client.disconnect();
  });

  it("BEAD-02: Multi-receiver Webhook Hub dispatches to both ZeroClaw and PicoClaw receivers concurrently", async () => {
    const receivedZeroClaw: WebhookEventPayload[] = [];
    const receivedPicoClaw: WebhookEventPayload[] = [];

    // Mock ZeroClaw Webhook Server
    const zeroClawServer = Bun.serve({
      port: 0,
      fetch(req) {
        return (async () => {
          const body = (await req.json()) as WebhookEventPayload;
          receivedZeroClaw.push(body);
          return new Response("OK", { status: 200 });
        })();
      },
    });

    // Mock PicoClaw Webhook Server
    const picoClawServer = Bun.serve({
      port: 0,
      fetch(req) {
        return (async () => {
          const body = (await req.json()) as WebhookEventPayload;
          receivedPicoClaw.push(body);
          return new Response("OK", { status: 200 });
        })();
      },
    });

    process.env.ZEROCLAW_WEBHOOK_URL = `http://localhost:${zeroClawServer.port}/zeroclaw/webhook`;
    process.env.PICOCLAW_WEBHOOK_URL = `http://localhost:${picoClawServer.port}/picoclaw/webhook`;

    const eventPayload: WebhookEventPayload = {
      event: "pi_nudge",
      source: "pi-api",
      sessionId: "dual-sess",
      taskId: "task-dual-1",
      message: "Dual orchestrator update",
      summary: "Dual orchestrator update",
      level: "info",
      completedAt: new Date().toISOString(),
    };

    const results = await dispatchWebhookEvent(eventPayload);
    expect(results.length).toBe(2);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    expect(receivedZeroClaw.length).toBe(1);
    expect(receivedZeroClaw[0].message).toBe("Dual orchestrator update");

    expect(receivedPicoClaw.length).toBe(1);
    expect(receivedPicoClaw[0].message).toBe("Dual orchestrator update");

    zeroClawServer.stop(true);
    picoClawServer.stop(true);
  });
});
