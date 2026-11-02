import { describe, expect, it } from "bun:test";
import {
  parsePairingCode,
  parseGatewayPortFromConfig,
  readPersistedNudgeConfig,
  writePersistedNudgeConfig,
  type NudgeConfig,
} from "./zeroclaw-discovery";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

describe("ZeroClaw Discovery & Auto-Pairing", () => {
  it("extracts pairing code from CLI output", () => {
    const cliOutput = `
      🔐 Gateway pairing is enabled.
      ┌──────────────┐
      │  v0Bssf4AFFeX8RuIWTv7pB9GGymgrKQe  │
      └──────────────┘
      Use this one-time code to pair a new device:
        POST /pair with header X-Pairing-Code: v0Bssf4AFFeX8RuIWTv7pB9GGymgrKQe
    `;
    const code = parsePairingCode(cliOutput);
    expect(code).toBe("v0Bssf4AFFeX8RuIWTv7pB9GGymgrKQe");
  });

  it("returns null if no pairing code found in output", () => {
    const cliOutput = "No code available";
    expect(parsePairingCode(cliOutput)).toBeNull();
  });

  it("parses gateway port from TOML content or defaults to 42617", () => {
    const tomlWithPort = `
      [gateway]
      port = 8080
      web_dist_dir = "/dist"
    `;
    expect(parseGatewayPortFromConfig(tomlWithPort)).toBe(8080);

    const tomlWithoutPort = `
      [gateway]
      web_dist_dir = "/dist"
    `;
    expect(parseGatewayPortFromConfig(tomlWithoutPort)).toBe(42617);

    expect(parseGatewayPortFromConfig("")).toBe(42617);
  });

  it("reads and writes persisted nudge config to a file path", () => {
    const tempFile = join(tmpdir(), `pi-api-nudge-test-${Date.now()}.json`);
    const sampleConfig: NudgeConfig = {
      gatewayUrl: "http://127.0.0.1:42617/webhook",
      token: "zc_sample_token_12345",
      updatedAt: new Date().toISOString(),
    };

    writePersistedNudgeConfig(tempFile, sampleConfig);
    const loaded = readPersistedNudgeConfig(tempFile);

    expect(loaded).not.toBeNull();
    expect(loaded?.token).toBe("zc_sample_token_12345");
    expect(loaded?.gatewayUrl).toBe("http://127.0.0.1:42617/webhook");

    try {
      unlinkSync(tempFile);
    } catch {}
  });

  it("autoDiscoverZeroClaw pairs successfully and persists token", async () => {
    const tempFile = join(tmpdir(), `pi-api-nudge-auto-${Date.now()}.json`);
    let pairHeaderReceived = "";

    const mockServer = Bun.serve({
      port: 0,
      fetch(req) {
        if (req.method === "POST" && new URL(req.url).pathname === "/pair") {
          pairHeaderReceived = req.headers.get("X-Pairing-Code") || "";
          return Response.json({
            paired: true,
            persisted: true,
            token: "zc_auto_paired_token_999",
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    const mockSpawn = async () => ({
      stdout: "Use this one-time code to pair: POST /pair with header X-Pairing-Code: secretCode123",
      exitCode: 0,
    });

    // Provide custom config pointing to mock server port
    const tempToml = join(tmpdir(), `zeroclaw-config-${Date.now()}.toml`);
    Bun.write(tempToml, `[gateway]\nport = ${mockServer.port}\n`);

    const { autoDiscoverZeroClaw } = await import("./zeroclaw-discovery");
    const result = await autoDiscoverZeroClaw({
      nudgeFilePath: tempFile,
      configPath: tempToml,
      spawnCommand: mockSpawn,
    });

    expect(result).not.toBeNull();
    expect(result?.token).toBe("zc_auto_paired_token_999");
    expect(pairHeaderReceived).toBe("secretCode123");

    // Calling again returns cached config without re-running pairing
    let secondCallRan = false;
    const resultCached = await autoDiscoverZeroClaw({
      nudgeFilePath: tempFile,
      configPath: tempToml,
      spawnCommand: async () => {
        secondCallRan = true;
        return { stdout: "", exitCode: 0 };
      },
    });

    expect(resultCached?.token).toBe("zc_auto_paired_token_999");
    expect(secondCallRan).toBe(false);

    mockServer.stop(true);
    try {
      unlinkSync(tempFile);
      unlinkSync(tempToml);
    } catch {}
  });
});
