import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createServer } from "../server/server";
import { PiBridgeClient } from "../client/connector";
import type { SessionInfo, ZeroClawWebhookPayload } from "../shared/protocol";

describe("End-to-End Integration Test", () => {
  let gatewayServer: ReturnType<typeof createServer>;
  let mockZeroClawServer: ReturnType<typeof Bun.serve>;
  let gatewayUrl: string;
  let mockWebhookUrl: string;
  const receivedWebhooks: ZeroClawWebhookPayload[] = [];

  const TEST_GATEWAY_PORT = 8790;
  const TEST_WEBHOOK_PORT = 8791;

  beforeAll(async () => {
    // 1. Start mock ZeroClaw webhook HTTP server
    mockZeroClawServer = Bun.serve({
      port: TEST_WEBHOOK_PORT,
      fetch(req) {
        if (req.method === "POST" && new URL(req.url).pathname === "/webhook") {
          return (async () => {
            const body = (await req.json()) as ZeroClawWebhookPayload;
            receivedWebhooks.push(body);
            return new Response(JSON.stringify({ received: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          })();
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    mockWebhookUrl = `http://localhost:${mockZeroClawServer.port}/webhook`;

    // 2. Start Gateway Server
    gatewayServer = createServer({ port: TEST_GATEWAY_PORT });
    gatewayUrl = `ws://localhost:${gatewayServer.port}/ws`;
  });

  afterAll(async () => {
    gatewayServer.stop(true);
    mockZeroClawServer.stop(true);
  });

  it("completes full lifecycle: connect, prompt dispatch, status updates, completion & webhook delivery", async () => {
    const sessionId = "session-e2e-12345";
    const testCwd = "/tmp/workspace-e2e";
    const testModel = "anthropic/claude-3-7-sonnet";

    // 1. Initialize PiBridgeClient and connect to Gateway
    const client = new PiBridgeClient({
      gatewayUrl,
      sessionId,
      cwd: testCwd,
      model: testModel,
    });

    await client.connect();

    // Small delay to ensure registration processed
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 2. Verify session appears in GET /sessions
    const sessionsRes = await fetch(`http://localhost:${gatewayServer.port}/sessions`);
    expect(sessionsRes.status).toBe(200);
    const sessionsList = (await sessionsRes.json()) as SessionInfo[];
    const sessionFound = sessionsList.find((s) => s.id === sessionId);
    expect(sessionFound).toBeDefined();
    expect(sessionFound?.cwd).toBe(testCwd);
    expect(sessionFound?.model).toBe(testModel);
    expect(sessionFound?.state).toBe("idle");

    // 3. Set up client prompt handler to simulate agent lifecycle:
    // Prompt received -> status: thinking -> status: executing_tool -> task_completed
    const promptDeferred = new Promise<{ taskId: string; prompt: string }>((resolve) => {
      client.onPrompt(async (taskId, prompt) => {
        resolve({ taskId, prompt });

        // Simulate thinking state
        client.updateStatus("thinking");
        await new Promise((r) => setTimeout(r, 20));

        // Simulate executing_tool state with active tool name
        client.updateStatus("executing_tool", "bash");
        await new Promise((r) => setTimeout(r, 20));

        // Complete task
        client.completeTask({
          taskId,
          summary: "E2E task completed successfully: generated files and ran tests.",
        });
      });
    });

    // 4. Post prompt via POST /sessions/:id/prompt with per-task webhookUrl
    const postPromptRes = await fetch(
      `http://localhost:${gatewayServer.port}/sessions/${encodeURIComponent(sessionId)}/prompt`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Write an end-to-end test and document the system",
          webhookUrl: mockWebhookUrl,
        }),
      }
    );

    expect(postPromptRes.status).toBe(202);
    const promptResponse = await postPromptRes.json();
    expect(promptResponse.accepted).toBe(true);
    expect(promptResponse.sessionId).toBe(sessionId);
    expect(promptResponse.taskId).toBeDefined();

    // 5. Verify client received prompt
    const receivedPrompt = await promptDeferred;
    expect(receivedPrompt.taskId).toBe(promptResponse.taskId);
    expect(receivedPrompt.prompt).toBe("Write an end-to-end test and document the system");

    // 6. Wait for webhook delivery to mock ZeroClaw server
    const maxWaitTime = 2000;
    const startTime = Date.now();
    while (receivedWebhooks.length === 0 && Date.now() - startTime < maxWaitTime) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(receivedWebhooks.length).toBe(1);
    const webhookPayload = receivedWebhooks[0];
    expect(webhookPayload.event).toBe("pi_task_completed");
    expect(webhookPayload.sessionId).toBe(sessionId);
    expect(webhookPayload.taskId).toBe(promptResponse.taskId);
    expect(webhookPayload.summary).toBe(
      "E2E task completed successfully: generated files and ran tests."
    );
    expect(webhookPayload.completedAt).toBeDefined();

    // 7. Verify session status returns to idle on gateway
    const statusRes = await fetch(
      `http://localhost:${gatewayServer.port}/sessions/${encodeURIComponent(sessionId)}/status`
    );
    expect(statusRes.status).toBe(200);
    const finalStatus = (await statusRes.json()) as SessionInfo;
    expect(finalStatus.state).toBe("idle");
    expect(finalStatus.activeTool).toBeUndefined();

    // Cleanup client connection
    client.disconnect();
  });
});
