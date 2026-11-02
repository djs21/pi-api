import type {
  ClientMessage,
  ClientNudgeMessage,
  NudgeLevel,
  ServerMessage,
  SessionState,
} from "../shared/protocol";

export interface PiBridgeClientOptions {
  gatewayUrl?: string;
  sessionId: string;
  alias?: string;
  cwd: string;
  model?: string;
}

export type PromptHandler = (taskId: string, prompt: string) => void | Promise<void>;
export type SteerHandler = (instruction: string, targetTaskId?: string) => void | Promise<void>;
export type InterruptHandler = () => void | Promise<void>;

export interface TaskCompletionPayload {
  taskId?: string;
  summary: string;
  output?: string;
  completedAt?: string;
}

export class PiBridgeClient {
  private ws: WebSocket | null = null;
  private gatewayUrl: string;
  private sessionId: string;
  private alias?: string;
  private cwd: string;
  private model?: string;

  private promptHandlers: Set<PromptHandler> = new Set();
  private steerHandlers: Set<SteerHandler> = new Set();
  private interruptHandlers: Set<InterruptHandler> = new Set();

  private isClosedManually = false;

  constructor(options: PiBridgeClientOptions) {
    this.gatewayUrl =
      options.gatewayUrl ||
      (typeof process !== "undefined" && process.env?.PI_GATEWAY_URL) ||
      "ws://localhost:8765/ws";
    this.sessionId = options.sessionId;
    this.alias = options.alias;
    this.cwd = options.cwd;
    this.model = options.model;
  }

  public connect(): Promise<void> {
    this.isClosedManually = false;

    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(this.gatewayUrl);
        this.ws = ws;

        ws.onopen = () => {
          this.sendRegister();
          resolve();
        };

        ws.onmessage = (event) => {
          this.handleServerMessage(event.data);
        };

        ws.onerror = (err) => {
          // If connection failed before open, reject
          if (ws.readyState !== WebSocket.OPEN) {
            reject(err);
          }
        };

        ws.onclose = () => {
          this.ws = null;
          if (!this.isClosedManually) {
            this.scheduleReconnect();
          }
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  public onPrompt(handler: PromptHandler): () => void {
    this.promptHandlers.add(handler);
    return () => this.promptHandlers.delete(handler);
  }

  public onSteer(handler: SteerHandler): () => void {
    this.steerHandlers.add(handler);
    return () => this.steerHandlers.delete(handler);
  }

  public onInterrupt(handler: InterruptHandler): () => void {
    this.interruptHandlers.add(handler);
    return () => this.interruptHandlers.delete(handler);
  }

  public updateStatus(state: SessionState, activeTool?: string): void {
    const msg: ClientMessage = {
      type: "status_update",
      sessionId: this.sessionId,
      state,
      activeTool,
    };
    this.send(msg);
  }

  public isConnected(): boolean {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  public sendNudge(payload: {
    taskId: string;
    message: string;
    level?: NudgeLevel;
    data?: Record<string, unknown>;
    sessionId?: string;
  }): void {
    const msg: ClientMessage = {
      type: "nudge",
      sessionId: payload.sessionId || this.sessionId,
      taskId: payload.taskId,
      message: payload.message,
      level: payload.level,
      data: payload.data,
      timestamp: new Date().toISOString(),
    };
    this.send(msg);
  }

  public completeTask(payload: TaskCompletionPayload): void {
    const msg: ClientMessage = {
      type: "task_completed",
      sessionId: this.sessionId,
      taskId: payload.taskId,
      summary: payload.summary,
      output: payload.output,
      completedAt: payload.completedAt || new Date().toISOString(),
    };
    this.send(msg);
  }

  public disconnect(): void {
    this.isClosedManually = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private sendRegister(): void {
    const msg: ClientMessage = {
      type: "register",
      sessionId: this.sessionId,
      alias: this.alias,
      cwd: this.cwd,
      model: this.model,
    };
    this.send(msg);
  }

  private send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleServerMessage(data: unknown): void {
    try {
      const text = typeof data === "string" ? data : data?.toString?.() ?? "";
      if (!text) return;

      const message = JSON.parse(text) as ServerMessage;
      switch (message.type) {
        case "prompt": {
          const rawPrompt =
            (message as any).prompt ??
            (message as any).content ??
            (message as any).text;

          if (typeof rawPrompt !== "string" || !rawPrompt.trim()) {
            console.warn(
              "[pi-bridge] Received empty or invalid prompt from server. Skipping execution.",
              message
            );
            break;
          }

          for (const handler of this.promptHandlers) {
            try {
              handler(message.taskId, rawPrompt);
            } catch (err) {
              console.error("Error executing prompt handler:", err);
            }
          }
          break;
        }

        case "steer": {
          const steerText = message.instruction || message.message || "";
          if (!steerText.trim()) {
            console.warn("[pi-bridge] Received empty steer instruction from server.");
            break;
          }
          for (const handler of this.steerHandlers) {
            try {
              handler(steerText, message.targetTaskId);
            } catch (err) {
              console.error("Error executing steer handler:", err);
            }
          }
          break;
        }

        case "interrupt":
          for (const handler of this.interruptHandlers) {
            try {
              handler();
            } catch (err) {
              console.error("Error executing interrupt handler:", err);
            }
          }
          break;

        case "ping":
          this.send({ type: "pong" });
          break;
      }
    } catch (err) {
      console.error("Failed to parse server message:", err);
    }
  }

  private reconnectTimer: any = null;

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.isClosedManually) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isClosedManually && (!this.ws || this.ws.readyState !== WebSocket.OPEN)) {
        this.connect().catch(() => {
          this.scheduleReconnect();
        });
      }
    }, 2000);
  }
}
