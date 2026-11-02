import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { unlinkSync, existsSync, writeFileSync } from "fs";
import {
  getDefaultTelegramConfigPath,
  readPersistedTelegramConfig,
  writeTelegramConfig,
  discoverTelegramPeerFromZeroClaw,
  resolveTelegramConfig,
  type TelegramNotifierConfig,
} from "./telegram-config";

describe("BEAD-01: Telegram Notifier Config & Environment Discovery", () => {
  let tempConfigFile: string;
  let tempTomlFile: string;

  beforeEach(() => {
    tempConfigFile = join(tmpdir(), `tg-cfg-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    tempTomlFile = join(tmpdir(), `zc-cfg-test-${Date.now()}-${Math.random().toString(36).slice(2)}.toml`);
  });

  afterEach(() => {
    if (existsSync(tempConfigFile)) unlinkSync(tempConfigFile);
    if (existsSync(tempTomlFile)) unlinkSync(tempTomlFile);
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DEFAULT_TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_NOTIFIER_ENABLED;
  });

  it("points to ~/.pi/agent/telegram-notifier.json as the default config path", () => {
    const expected = join(homedir(), ".pi", "agent", "telegram-notifier.json");
    expect(getDefaultTelegramConfigPath()).toBe(expected);
  });

  it("writes and reads persisted telegram configuration from disk", () => {
    const cfg: TelegramNotifierConfig = {
      botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
      defaultChatId: "123456789",
      enabled: true,
    };

    writeTelegramConfig(cfg, tempConfigFile);
    expect(existsSync(tempConfigFile)).toBe(true);

    const loaded = readPersistedTelegramConfig(tempConfigFile);
    expect(loaded).toBeDefined();
    expect(loaded?.botToken).toBe(cfg.botToken);
    expect(loaded?.defaultChatId).toBe(cfg.defaultChatId);
    expect(loaded?.enabled).toBe(true);
    expect(loaded?.updatedAt).toBeDefined();
  });

  it("discovers external_peers numeric telegram chat ID from ZeroClaw config TOML", () => {
    const tomlContent = `
[peer_groups.telegram_default]
channel = "telegram.default"
external_peers = ["username_abc", "123456789", "other_user"]
output_modality = "mirror"
`;
    writeFileSync(tempTomlFile, tomlContent, "utf-8");

    const peerId = discoverTelegramPeerFromZeroClaw(tempTomlFile);
    expect(peerId).toBe("123456789");
  });

  it("resolves config with correct precedence: Env > Persisted File > ZeroClaw Discovery", () => {
    // 1. ZeroClaw fallback
    const tomlContent = `
[peer_groups.telegram_default]
external_peers = ["999999999"]
`;
    writeFileSync(tempTomlFile, tomlContent, "utf-8");

    let resolved = resolveTelegramConfig({
      customConfigPath: tempConfigFile,
      customTomlPath: tempTomlFile,
      customSecurityYmlPath: "/non-existent-security.yml",
      customConfigJsonPath: "/non-existent-config.json",
    });
    expect(resolved.defaultChatId).toBe("999999999");
    expect(resolved.botToken).toBeUndefined();

    // 2. Persisted File overrides ZeroClaw fallback
    writeTelegramConfig(
      {
        botToken: "file-token-111",
        defaultChatId: "888888888",
        enabled: true,
      },
      tempConfigFile
    );

    resolved = resolveTelegramConfig({
      customConfigPath: tempConfigFile,
      customTomlPath: tempTomlFile,
    });
    expect(resolved.botToken).toBe("file-token-111");
    expect(resolved.defaultChatId).toBe("888888888");

    // 3. Env var overrides Persisted File
    process.env.TELEGRAM_BOT_TOKEN = "env-token-222";
    process.env.DEFAULT_TELEGRAM_CHAT_ID = "777777777";

    resolved = resolveTelegramConfig({
      customConfigPath: tempConfigFile,
      customTomlPath: tempTomlFile,
    });
    expect(resolved.botToken).toBe("env-token-222");
    expect(resolved.defaultChatId).toBe("777777777");
    expect(resolved.enabled).toBe(true);
  });
});
