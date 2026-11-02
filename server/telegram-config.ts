import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

export interface TelegramNotifierConfig {
  botToken?: string;
  defaultChatId?: string;
  enabled?: boolean;
  updatedAt?: string;
}

export function getDefaultTelegramConfigPath(): string {
  return join(homedir(), ".pi", "agent", "telegram-notifier.json");
}

export function readPersistedTelegramConfig(
  customPath?: string
): TelegramNotifierConfig | null {
  const filePath = customPath || getDefaultTelegramConfigPath();
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content) as TelegramNotifierConfig;
  } catch (err) {
    console.warn(`[pi-api] Failed to read persisted telegram config at ${filePath}:`, err);
    return null;
  }
}

export function writeTelegramConfig(
  config: TelegramNotifierConfig,
  customPath?: string
): void {
  const filePath = customPath || getDefaultTelegramConfigPath();
  try {
    const parentDir = dirname(filePath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    const dataWithTimestamp: TelegramNotifierConfig = {
      ...config,
      updatedAt: config.updatedAt || new Date().toISOString(),
    };
    writeFileSync(filePath, JSON.stringify(dataWithTimestamp, null, 2), "utf-8");
    // Credentials file: restrict to owner only.
    chmodSync(filePath, 0o600);
  } catch (err) {
    console.warn(`[pi-api] Failed to write telegram config to ${filePath}:`, err);
  }
}

/**
 * Coba ekstrak Telegram bot token & chat ID dari konfigurasi PicoClaw jika ada:
 * - Token dari ~/.picoclaw/.security.yml (telegram.settings.token)
 * - Chat ID dari ~/.picoclaw/config.json (channel_list.telegram.allow_from)
 */
export function discoverTelegramFromPicoClaw(options?: {
  customSecurityYmlPath?: string;
  customConfigJsonPath?: string;
}): { botToken?: string; chatId?: string } {
  const result: { botToken?: string; chatId?: string } = {};

  const securityYmlPath =
    options?.customSecurityYmlPath || join(homedir(), ".picoclaw", ".security.yml");
  try {
    if (existsSync(securityYmlPath)) {
      const content = readFileSync(securityYmlPath, "utf-8");
      // Format YAML:
      // telegram:
      //   settings:
      //     token: <TELEGRAM_BOT_TOKEN>
      const match = content.match(/telegram:\s*\n\s*settings:\s*\n\s*token:\s*([^\s\n]+)/);
      if (match && match[1]) {
        result.botToken = match[1].trim();
      }
    }
  } catch {
    // Ignore error
  }

  const configJsonPath =
    options?.customConfigJsonPath || join(homedir(), ".picoclaw", "config.json");
  try {
    if (existsSync(configJsonPath)) {
      const content = readFileSync(configJsonPath, "utf-8");
      const data = JSON.parse(content);
      const allowFrom: string[] =
        data?.channel_list?.telegram?.allow_from || [];
      const numericId = allowFrom.find((id) => /^\d+$/.test(id));
      if (numericId) {
        result.chatId = numericId;
      } else if (allowFrom.length > 0) {
        result.chatId = allowFrom[0];
      }
    }
  } catch {
    // Ignore error
  }

  return result;
}

/**
 * Otomatis inisialisasi file ~/.pi/agent/telegram-notifier.json bila belum ada
 * dan ditemukan token/chatId yang valid dari env / PicoClaw / ZeroClaw.
 */
export function autoInitTelegramNotifierConfig(options?: {
  customConfigPath?: string;
  customTomlPath?: string;
  customSecurityYmlPath?: string;
  customConfigJsonPath?: string;
}): TelegramNotifierConfig {
  const targetPath = options?.customConfigPath || getDefaultTelegramConfigPath();
  const existing = readPersistedTelegramConfig(targetPath);

  if (existing?.botToken && existing?.defaultChatId) {
    return existing;
  }

  const pico = discoverTelegramFromPicoClaw({
    customSecurityYmlPath: options?.customSecurityYmlPath,
    customConfigJsonPath: options?.customConfigJsonPath,
  });
  const zeroPeer = discoverTelegramPeerFromZeroClaw(options?.customTomlPath);

  const botToken =
    process.env.TELEGRAM_BOT_TOKEN ||
    existing?.botToken ||
    pico.botToken;

  const defaultChatId =
    process.env.DEFAULT_TELEGRAM_CHAT_ID ||
    process.env.TELEGRAM_CHAT_ID ||
    existing?.defaultChatId ||
    pico.chatId ||
    zeroPeer;

  const enabled =
    process.env.TELEGRAM_NOTIFIER_ENABLED !== undefined
      ? process.env.TELEGRAM_NOTIFIER_ENABLED === "true" ||
        process.env.TELEGRAM_NOTIFIER_ENABLED === "1"
      : existing?.enabled !== undefined
      ? existing.enabled
      : Boolean(botToken && defaultChatId);

  const mergedConfig: TelegramNotifierConfig = {
    botToken,
    defaultChatId,
    enabled,
    updatedAt: new Date().toISOString(),
  };

  if (botToken && defaultChatId) {
    writeTelegramConfig(mergedConfig, targetPath);
    console.log(
      `[pi-api] 📱 Telegram notifier auto-initialized and saved to ${targetPath} (Chat ID: ${defaultChatId})`
    );
  }

  return mergedConfig;
}

/**
 * Coba ekstrak peer Telegram pertama dari ~/.zeroclaw/config.toml jika ada.
 * Contoh di config.toml:
 *   [peer_groups.telegram_default]
 *   external_peers = ["123456789", "some_username"]
 */
export function discoverTelegramPeerFromZeroClaw(customTomlPath?: string): string | null {
  const tomlPath = customTomlPath || join(homedir(), ".zeroclaw", "config.toml");
  try {
    if (!existsSync(tomlPath)) return null;
    const content = readFileSync(tomlPath, "utf-8");

    // Match array external_peers = ["123456789", ...]
    const peersMatch = content.match(/external_peers\s*=\s*\[([^\]]+)\]/);
    if (peersMatch && peersMatch[1]) {
      const items = peersMatch[1]
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      // Utamakan numeric id (misal 123456789) jika ada
      const numericId = items.find((id) => /^\d+$/.test(id));
      if (numericId) return numericId;
      if (items.length > 0) return items[0];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve konfigurasi aktif Telegram Notifier dengan urutan prioritas:
 * 1. Environment variables (TELEGRAM_BOT_TOKEN, DEFAULT_TELEGRAM_CHAT_ID / TELEGRAM_CHAT_ID)
 * 2. File konfigurasi di ~/.pi/agent/telegram-notifier.json
 * 3. Fallback auto-discovery defaultChatId dari ~/.zeroclaw/config.toml
 */
export function resolveTelegramConfig(options?: {
  customConfigPath?: string;
  customTomlPath?: string;
  customSecurityYmlPath?: string;
  customConfigJsonPath?: string;
}): TelegramNotifierConfig {
  const persisted = readPersistedTelegramConfig(options?.customConfigPath);
  const pico = discoverTelegramFromPicoClaw({
    customSecurityYmlPath: options?.customSecurityYmlPath,
    customConfigJsonPath: options?.customConfigJsonPath,
  });
  const discoveredChatId =
    discoverTelegramPeerFromZeroClaw(options?.customTomlPath) || pico.chatId;

  const botToken =
    process.env.TELEGRAM_BOT_TOKEN ||
    persisted?.botToken ||
    pico.botToken ||
    undefined;

  const defaultChatId =
    process.env.DEFAULT_TELEGRAM_CHAT_ID ||
    process.env.TELEGRAM_CHAT_ID ||
    persisted?.defaultChatId ||
    discoveredChatId ||
    undefined;

  const enabled =
    process.env.TELEGRAM_NOTIFIER_ENABLED !== undefined
      ? process.env.TELEGRAM_NOTIFIER_ENABLED === "true" ||
        process.env.TELEGRAM_NOTIFIER_ENABLED === "1"
      : persisted?.enabled !== undefined
      ? persisted.enabled
      : Boolean(botToken && defaultChatId);

  return {
    botToken,
    defaultChatId,
    enabled,
    updatedAt: persisted?.updatedAt || new Date().toISOString(),
  };
}
