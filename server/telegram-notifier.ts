import { resolveTelegramConfig, type TelegramNotifierConfig } from "./telegram-config";

export interface TelegramNotifyOptions {
  text: string;
  chatId?: string;
  parseMode?: "HTML" | "MarkdownV2" | "Markdown";
  disableNotification?: boolean;
}

export interface TelegramTaskNotificationOptions {
  event: "task_completed" | "nudge";
  sessionId: string;
  taskId: string;
  summary?: string;
  message?: string;
  level?: "info" | "warning" | "question" | "needs_action";
  chatIdOverride?: string;
}

/**
 * Format notifikasi rapi untuk Telegram (HTML mode)
 */
export function formatTelegramNotification(opts: TelegramTaskNotificationOptions): string {
  if (opts.event === "task_completed") {
    const title = `🚀 <b>Pi Agent: Task Selesai</b>`;
    const taskInfo = `<b>Task ID:</b> <code>${escapeHtml(opts.taskId || "default")}</code>\n<b>Session:</b> <code>${escapeHtml(opts.sessionId)}</code>`;
    const summary = opts.summary
      ? `\n\n<b>Ringkasan:</b>\n${escapeHtml(opts.summary)}`
      : "";
    return `${title}\n\n${taskInfo}${summary}`;
  }

  // Event Nudge
  const levelEmojiMap: Record<string, string> = {
    info: "ℹ️",
    warning: "⚠️",
    question: "❓",
    needs_action: "🚨",
  };
  const emoji = levelEmojiMap[opts.level || "info"] || "🔔";
  const levelUpper = (opts.level || "info").toUpperCase();
  const title = `${emoji} <b>Pi Agent Nudge [${levelUpper}]</b>`;
  const taskInfo = `<b>Task ID:</b> <code>${escapeHtml(opts.taskId || "default")}</code>\n<b>Session:</b> <code>${escapeHtml(opts.sessionId)}</code>`;
  const msg = opts.message ? `\n\n<b>Pesan:</b>\n${escapeHtml(opts.message)}` : "";
  return `${title}\n\n${taskInfo}${msg}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Mengirim pesan langsung ke Telegram Bot API (sendMessage).
 * Bersifat non-blocking dan graceful jika koneksi offline.
 */
export async function sendTelegramNotification(
  options: TelegramNotifyOptions,
  configOverride?: TelegramNotifierConfig
): Promise<boolean> {
  const cfg = configOverride || resolveTelegramConfig();

  if (!cfg.enabled) {
    return false;
  }

  const token = cfg.botToken;
  const targetChatId = options.chatId || cfg.defaultChatId;

  if (!token || !targetChatId) {
    return false;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: targetChatId,
        text: options.text,
        parse_mode: options.parseMode || "HTML",
        disable_notification: options.disableNotification || false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (res.ok) {
      console.log(`[pi-api] 📱 Telegram message sent to chat ${targetChatId}`);
      return true;
    } else {
      const errText = await res.text().catch(() => "Unknown error");
      console.warn(`[pi-api] ❌ Failed to send Telegram message (Status ${res.status}): ${errText}`);
      return false;
    }
  } catch (err: any) {
    clearTimeout(timeoutId);
    console.warn(`[pi-api] ❌ Telegram notification request error:`, err?.message || err);
    return false;
  }
}
