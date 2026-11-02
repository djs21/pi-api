import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { WebhookEventPayload } from "../shared/protocol";
import {
  DEFAULT_ZEROCLAW_PORT,
  getDefaultNudgeFilePath,
  readPersistedNudgeConfig,
  resolveZeroClawPort,
} from "./zeroclaw-discovery";

export const DEFAULT_PICOCLAW_PORT = 18790;

export interface ReceiverConfig {
  name: "zeroclaw" | "picoclaw" | string;
  enabled: boolean;
  webhookUrl: string;
  token?: string;
  updatedAt: string;
}

export interface MultiReceiverConfig {
  zeroclaw?: ReceiverConfig;
  picoclaw?: ReceiverConfig;
  [key: string]: ReceiverConfig | undefined;
}

export function getDefaultReceiversFilePath(): string {
  return join(homedir(), ".pi", "agent", "pi-api-receivers.json");
}

export function readPersistedReceivers(
  filePath: string = getDefaultReceiversFilePath()
): MultiReceiverConfig | null {
  try {
    if (existsSync(filePath)) {
      const data = JSON.parse(readFileSync(filePath, "utf-8")) as MultiReceiverConfig;
      if (data && typeof data === "object") {
        return data;
      }
    }
  } catch {
    // Ignore corrupted file
  }

  // Fallback: migrate/read from legacy pi-api-nudge.json
  const legacy = readPersistedNudgeConfig(getDefaultNudgeFilePath());
  if (legacy?.gatewayUrl) {
    return {
      zeroclaw: {
        name: "zeroclaw",
        enabled: true,
        webhookUrl: legacy.gatewayUrl,
        token: legacy.token,
        updatedAt: legacy.updatedAt || new Date().toISOString(),
      },
    };
  }

  return null;
}

export function writePersistedReceivers(
  filePath: string = getDefaultReceiversFilePath(),
  config: MultiReceiverConfig
): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
}

export function resolveReceivers(): ReceiverConfig[] {
  const persisted = readPersistedReceivers();
  const receivers: ReceiverConfig[] = [];

  // 1. Resolve ZeroClaw
  const zeroClawUrl =
    process.env.ZEROCLAW_WEBHOOK_URL ||
    persisted?.zeroclaw?.webhookUrl ||
    `http://127.0.0.1:${resolveZeroClawPort()}/webhook`;
  const zeroClawToken =
    process.env.ZEROCLAW_WEBHOOK_TOKEN || persisted?.zeroclaw?.token;

  receivers.push({
    name: "zeroclaw",
    enabled: true,
    webhookUrl: zeroClawUrl,
    token: zeroClawToken,
    updatedAt: persisted?.zeroclaw?.updatedAt || new Date().toISOString(),
  });

  // 2. Resolve PicoClaw
  const picoPort = process.env.PICOCLAW_PORT
    ? parseInt(process.env.PICOCLAW_PORT, 10) || DEFAULT_PICOCLAW_PORT
    : DEFAULT_PICOCLAW_PORT;
  const picoClawUrl =
    process.env.PICOCLAW_WEBHOOK_URL ||
    persisted?.picoclaw?.webhookUrl ||
    `http://127.0.0.1:${picoPort}/webhook`;
  const picoClawToken =
    process.env.PICOCLAW_WEBHOOK_TOKEN || persisted?.picoclaw?.token;

  const picoEnabled =
    Boolean(process.env.PICOCLAW_WEBHOOK_URL) ||
    Boolean(persisted?.picoclaw?.enabled) ||
    Boolean(process.env.PICOCLAW_PORT);

  receivers.push({
    name: "picoclaw",
    enabled: picoEnabled,
    webhookUrl: picoClawUrl,
    token: picoClawToken,
    updatedAt: persisted?.picoclaw?.updatedAt || new Date().toISOString(),
  });

  return receivers;
}

export async function dispatchWebhookEvent(
  event: WebhookEventPayload,
  taskWebhookUrl?: string,
  taskHeaders?: Record<string, string>
): Promise<PromiseSettledResult<Response>[]> {
  const targets: { url: string; headers: Record<string, string>; name: string }[] = [];

  // If specific task webhook is provided, it always gets dispatched
  if (taskWebhookUrl) {
    targets.push({
      name: "task-webhook",
      url: taskWebhookUrl,
      headers: {
        "Content-Type": "application/json",
        ...(taskHeaders || {}),
      },
    });
  }

  // Multi-receiver targets from discovery
  const receivers = resolveReceivers();
  for (const rc of receivers) {
    if (!rc.enabled) continue;
    if (event.target && event.target !== "all" && event.target !== rc.name) {
      continue;
    }
    // Avoid duplicate if same URL already in taskWebhookUrl
    if (targets.some((t) => t.url === rc.webhookUrl)) {
      continue;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (rc.token) {
      headers["Authorization"] = `Bearer ${rc.token}`;
    }

    targets.push({
      name: rc.name,
      url: rc.webhookUrl,
      headers,
    });
  }

  if (targets.length === 0) {
    console.warn(`[pi-api] No webhook receivers configured for event '${event.event}' (task '${event.taskId}')`);
    return [];
  }

  const dispatches = targets.map(async (target) => {
    console.log(
      `[pi-api] 🔔 Dispathing '${event.event}' to ${target.name} at ${target.url}...`
    );
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);

      const res = await fetch(target.url, {
        method: "POST",
        headers: target.headers,
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      console.log(
        `[pi-api] 🚀 Delivered '${event.event}' to ${target.name} (Status: ${res.status})`
      );
      return res;
    } catch (err: any) {
      console.error(
        `[pi-api] ❌ Failed to dispatch webhook to ${target.name} (${target.url}):`,
        err?.message || err
      );
      throw err;
    }
  });

  return Promise.allSettled(dispatches);
}
