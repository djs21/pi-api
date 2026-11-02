import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface NudgeConfig {
  gatewayUrl: string;
  token: string;
  updatedAt: string;
}

export const DEFAULT_ZEROCLAW_PORT = 42617;

export function getDefaultNudgeFilePath(): string {
  return join(homedir(), ".pi", "agent", "pi-api-nudge.json");
}

export function getDefaultZeroClawConfigPath(): string {
  return join(homedir(), ".zeroclaw", "config.toml");
}

export function parsePairingCode(cliOutput: string): string | null {
  const match = cliOutput.match(/X-Pairing-Code:\s*([A-Za-z0-9_-]+)/i);
  return match ? match[1] : null;
}

export function parseGatewayPortFromConfig(tomlContent: string): number {
  if (!tomlContent) return DEFAULT_ZEROCLAW_PORT;

  // Simple regex parser for [gateway] section port = 1234
  const gatewaySectionMatch = tomlContent.match(/\[gateway\][^\[]*/s);
  if (gatewaySectionMatch) {
    const portMatch = gatewaySectionMatch[0].match(/port\s*=\s*(\d+)/);
    if (portMatch) {
      const parsed = parseInt(portMatch[1], 10);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }

  // Fallback to top-level port if any
  const topPortMatch = tomlContent.match(/^port\s*=\s*(\d+)/m);
  if (topPortMatch) {
    const parsed = parseInt(topPortMatch[1], 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return DEFAULT_ZEROCLAW_PORT;
}

export function resolveZeroClawPort(configPath: string = getDefaultZeroClawConfigPath()): number {
  if (process.env.ZEROCLAW_PORT) {
    const envPort = parseInt(process.env.ZEROCLAW_PORT, 10);
    if (!isNaN(envPort) && envPort > 0) return envPort;
  }

  try {
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, "utf-8");
      return parseGatewayPortFromConfig(content);
    }
  } catch {
    // Ignore error and fall back to default
  }

  return DEFAULT_ZEROCLAW_PORT;
}

export function readPersistedNudgeConfig(filePath: string = getDefaultNudgeFilePath()): NudgeConfig | null {
  try {
    if (!existsSync(filePath)) return null;
    const data = JSON.parse(readFileSync(filePath, "utf-8")) as NudgeConfig;
    if (data && typeof data.token === "string" && typeof data.gatewayUrl === "string") {
      return data;
    }
  } catch {
    // Ignore corrupted file
  }
  return null;
}

export function writePersistedNudgeConfig(
  filePath: string,
  config: NudgeConfig
): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
  // Bearer token file: restrict to owner only.
  chmodSync(filePath, 0o600);
}

export async function requestPairing(
  pairUrl: string,
  pairingCode: string
): Promise<string | null> {
  try {
    const res = await fetch(pairUrl, {
      method: "POST",
      headers: {
        "X-Pairing-Code": pairingCode,
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { paired?: boolean; token?: string };
    if (body.paired && body.token) {
      return body.token;
    }
  } catch {
    // Pairing request failed
  }
  return null;
}

export async function autoDiscoverZeroClaw(options: {
  nudgeFilePath?: string;
  configPath?: string;
  spawnCommand?: (cmd: string[]) => Promise<{ stdout: string; exitCode: number }>;
} = {}): Promise<NudgeConfig | null> {
  const nudgeFilePath = options.nudgeFilePath ?? getDefaultNudgeFilePath();
  const configPath = options.configPath ?? getDefaultZeroClawConfigPath();

  // 1. Check if token already exists and is persisted
  const existing = readPersistedNudgeConfig(nudgeFilePath);
  if (existing) {
    return existing;
  }

  // 2. Discover gateway port
  const port = resolveZeroClawPort(configPath);
  const baseUrl = `http://127.0.0.1:${port}`;
  const webhookUrl = `${baseUrl}/webhook`;
  const pairUrl = `${baseUrl}/pair`;

  // 3. Obtain pairing code from CLI
  let pairingCode: string | null = null;
  try {
    let stdout = "";
    if (options.spawnCommand) {
      const res = await options.spawnCommand(["zeroclaw", "gateway", "get-paircode", "--new"]);
      stdout = res.stdout;
    } else {
      const proc = Bun.spawn(["zeroclaw", "gateway", "get-paircode", "--new"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      stdout = await new Response(proc.stdout).text();
      await proc.exited;
    }
    pairingCode = parsePairingCode(stdout);
  } catch (err) {
    // CLI execution failed (zeroclaw might not be installed or not running)
    return null;
  }

  if (!pairingCode) {
    return null;
  }

  // 4. Request pairing token
  const token = await requestPairing(pairUrl, pairingCode);
  if (!token) {
    return null;
  }

  const newConfig: NudgeConfig = {
    gatewayUrl: webhookUrl,
    token,
    updatedAt: new Date().toISOString(),
  };

  try {
    writePersistedNudgeConfig(nudgeFilePath, newConfig);
  } catch {
    // Non-fatal write failure
  }

  return newConfig;
}
