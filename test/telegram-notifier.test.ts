import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createServer } from "../server/server";
import {
  sendTelegramNotification,
  formatTelegramNotification,
} from "../server/telegram-notifier";
import {
  writeTelegramConfig,
  type TelegramNotifierConfig,
} from "../server/telegram-config";

describe("BEAD-02 to BEAD-05: Telegram Notifier Service & Event Integration", () => {
  let mockTelegramCalls: Array<{ url: string; body: any }> = [];
  let mockTelegramServer: ReturnType<typeof Bun.serve>;
  let mockTelegramPort: number;

  let gatewayServer: ReturnType<typeof createServer>;
  let gatewayPort: number;
  let baseUrl: string;
  let wsUrl: string;

  beforeEach(() => {
    mockTelegramCalls = [];

    // Mock Telegram Bot API Server
    mockTelegramServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json();
        mockTelegramCalls.push({ url: req.url, body });
        return Response.json({ ok: true, result: { message_id: 12345 } });
      },
    });
    mockTelegramPort = mockTelegramServer.port;

    gatewayServer = createServer({ port: 0 });
    gatewayPort = gatewayServer.port;
    baseUrl = `http://localhost:${gatewayPort}`;
    wsUrl = `ws://localhost:${gatewayPort}/ws`;
  });

  afterEach(() => {
    mockTelegramServer.stop(true);
    gatewayServer.stop(true);
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DEFAULT_TELEGRAM_CHAT_ID;
  });

  it("BEAD-02: formatTelegramNotification produces clean HTML text for task_completed and nudge", () => {
    const completedText = formatTelegramNotification({
      event: "task_completed",
      sessionId: "sess-1",
      taskId: "task-abc",
      summary: "Refactored auth module & all tests pass",
    });

    expect(completedText).toContain("Pi Agent: Task Selesai");
    expect(completedText).toContain("<code>task-abc</code>");
    expect(completedText).toContain("Refactored auth module &amp; all tests pass");

    const nudgeText = formatTelegramNotification({
      event: "nudge",
      sessionId: "sess-1",
      taskId: "task-xyz",
      message: "Database migration conflict detected",
      level: "warning",
    });

    expect(nudgeText).toContain("Pi Agent Nudge [WARNING]");
    expect(nudgeText).toContain("⚠️");
    expect(nudgeText).toContain("Database migration conflict detected");
  });

  it("BEAD-02: sendTelegramNotification sends direct HTTP POST with correct chat_id and text", async () => {
    const config: TelegramNotifierConfig = {
      botToken: "test-token-123",
      defaultChatId: "123456789",
      enabled: true,
    };

    // Override global fetch URL target during test by pointing to mock server
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (typeof url === "string" && url.includes("api.telegram.org")) {
        const localUrl = `http://localhost:${mockTelegramPort}/sendMessage`;
        return originalFetch(localUrl, init);
      }
      return originalFetch(url, init);
    }) as any;

    try {
      const success = await sendTelegramNotification(
        { text: "<b>Test Hello</b>", chatId: "998877" },
        config
      );

      expect(success).toBe(true);
      expect(mockTelegramCalls.length).toBe(1);
      expect(mockTelegramCalls[0].body.chat_id).toBe("998877");
      expect(mockTelegramCalls[0].body.text).toBe("<b>Test Hello</b>");
      expect(mockTelegramCalls[0].body.parse_mode).toBe("HTML");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("BEAD-03 & BEAD-04: Gateway triggers Telegram notification on task_completed and respects notify_chat_id override", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (typeof url === "string" && url.includes("api.telegram.org")) {
        const localUrl = `http://localhost:${mockTelegramPort}/sendMessage`;
        return originalFetch(localUrl, init);
      }
      return originalFetch(url, init);
    }) as any;

    process.env.TELEGRAM_BOT_TOKEN = "env-token-active";
    process.env.DEFAULT_TELEGRAM_CHAT_ID = "111111111";

    try {
      // Connect WS Client
      const ws = new WebSocket(wsUrl);
      let registered = false;
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "register",
            sessionId: "tg-sess-1",
            cwd: "/workspace",
          })
        );
        registered = true;
      };

      await new Promise((r) => setTimeout(r, 60));
      expect(registered).toBe(true);

      // Dispatch prompt with metadata.notify_chat_id override
      const promptRes = await fetch(`${baseUrl}/sessions/tg-sess-1/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Deploy service",
          taskId: "task-deploy-77",
          metadata: {
            notify_chat_id: "999999999", // Override default 111111111
          },
        }),
      });

      expect(promptRes.status).toBe(202);

      // Simulate task completion from agent
      ws.send(
        JSON.stringify({
          type: "task_completed",
          sessionId: "tg-sess-1",
          taskId: "task-deploy-77",
          summary: "Service deployment completed without errors",
          completedAt: new Date().toISOString(),
        })
      );

      await new Promise((r) => setTimeout(r, 80));

      expect(mockTelegramCalls.length).toBe(1);
      expect(mockTelegramCalls[0].body.chat_id).toBe("999999999");
      expect(mockTelegramCalls[0].body.text).toContain("Pi Agent: Task Selesai");
      expect(mockTelegramCalls[0].body.text).toContain("Service deployment completed without errors");

      ws.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("BEAD-03: Gateway triggers Telegram notification on nudge message", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (typeof url === "string" && url.includes("api.telegram.org")) {
        const localUrl = `http://localhost:${mockTelegramPort}/sendMessage`;
        return originalFetch(localUrl, init);
      }
      return originalFetch(url, init);
    }) as any;

    process.env.TELEGRAM_BOT_TOKEN = "env-token-active";
    process.env.DEFAULT_TELEGRAM_CHAT_ID = "123456789";

    try {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "register",
            sessionId: "tg-nudge-sess",
            cwd: "/workspace",
          })
        );
      };

      await new Promise((r) => setTimeout(r, 60));

      // Send nudge from agent
      ws.send(
        JSON.stringify({
          type: "nudge",
          sessionId: "tg-nudge-sess",
          taskId: "task-audit-12",
          message: "Encountered merge conflict in schema",
          level: "question",
        })
      );

      await new Promise((r) => setTimeout(r, 80));

      expect(mockTelegramCalls.length).toBe(1);
      expect(mockTelegramCalls[0].body.chat_id).toBe("123456789");
      expect(mockTelegramCalls[0].body.text).toContain("Pi Agent Nudge [QUESTION]");
      expect(mockTelegramCalls[0].body.text).toContain("Encountered merge conflict in schema");

      ws.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
