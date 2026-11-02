import { basename } from "node:path";
import { PiBridgeClient, type PiBridgeClientOptions } from "./connector";

export interface ExtensionAPI {
  sessionId?: string;
  session?: { id?: string };
  cwd?: string;
  model?: { id?: string } | string;
  on(event: string, handler: (...args: any[]) => void | Promise<void>): (() => void) | void;
  sendUserMessage?: (message: string, options?: any) => void | Promise<void>;
  injectMessage?: (message: string, options?: any) => void | Promise<void>;
  registerTool?: (tool: any) => void;
  [key: string]: any;
}

export function createPiExtension(options?: Partial<PiBridgeClientOptions>) {
  return function piExtension(api: ExtensionAPI) {
    const sessionId =
      options?.sessionId ||
      api.sessionId ||
      api.session?.id ||
      (typeof process !== "undefined" && process.env?.PI_SESSION_ID) ||
      crypto.randomUUID();

    const cwd =
      options?.cwd ||
      api.cwd ||
      (typeof process !== "undefined" && process.cwd?.()) ||
      ".";

    const model =
      options?.model ||
      (typeof api.model === "string" ? api.model : api.model?.id) ||
      (typeof process !== "undefined" && process.env?.PI_MODEL) ||
      undefined;

    const alias =
      options?.alias ||
      (typeof process !== "undefined" && process.env?.PI_SESSION_ALIAS) ||
      (cwd && cwd !== "." ? basename(cwd) : "default");

    const gatewayUrl =
      options?.gatewayUrl ||
      (typeof process !== "undefined" && process.env?.PI_GATEWAY_URL) ||
      undefined;

    const client = new PiBridgeClient({
      gatewayUrl,
      sessionId,
      alias,
      cwd,
      model,
    });

    let activePiApiTask: { taskId: string; sessionId: string } | null = null;
    let currentTaskId: string | null = null;
    let hasActiveWork = false;
    let lastSummary = "Task execution finished.";
    let lastFullOutput = "";

    client.onPrompt((taskId, prompt) => {
      if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
        console.warn("[pi-bridge] Received empty or invalid prompt. Ignoring.");
        return;
      }
      activePiApiTask = { taskId, sessionId };
      currentTaskId = taskId;
      hasActiveWork = true;
      if (typeof api.sendUserMessage === "function") {
        api.sendUserMessage(prompt);
      } else if (typeof api.injectMessage === "function") {
        api.injectMessage(prompt);
      }
    });

    client.onSteer((instruction) => {
      if (!instruction || typeof instruction !== "string" || !instruction.trim()) {
        return;
      }
      if (typeof api.sendUserMessage === "function") {
        api.sendUserMessage(instruction, { deliverAs: "steer" });
      } else if (typeof api.injectMessage === "function") {
        api.injectMessage(instruction);
      }
    });

    if (typeof api.registerTool === "function") {
      api.registerTool({
        name: "nudge_orchestrator",
        description:
          "Send an asynchronous status update, progress report, or question back to the orchestrator (PicoClaw/ZeroClaw). " +
          "This tool is ONLY active during a task dispatched via pi-api and will reject execution if run standalone.",
        parameters: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "Message, progress update, or query for the orchestrator",
            },
            level: {
              type: "string",
              enum: ["info", "warning", "question", "needs_action"],
              description: "Urgency or category of the nudge",
            },
            data: {
              type: "object",
              description: "Optional metadata or structured payload",
            },
          },
          required: ["message"],
        },
        async execute(id: string, params: any) {
          if (!client.isConnected()) {
            return {
              content: [
                {
                  type: "text",
                  text: "Execution rejected: Agent is not connected to pi-api gateway (standalone mode).",
                },
              ],
              isError: true,
            };
          }

          if (!activePiApiTask) {
            return {
              content: [
                {
                  type: "text",
                  text: "Execution rejected: Tool 'nudge_orchestrator' is ONLY available when executing an active task dispatched via pi-api.",
                },
              ],
              isError: true,
            };
          }

          try {
            client.sendNudge({
              sessionId,
              taskId: activePiApiTask.taskId,
              message: params.message,
              level: params.level,
              data: params.data,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Nudge successfully sent to orchestrator for taskId '${activePiApiTask.taskId}'.`,
                },
              ],
            };
          } catch (err: any) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to send nudge: ${err?.message || err}`,
                },
              ],
              isError: true,
            };
          }
        },
      });
    }

    api.on("input", () => {
      hasActiveWork = true;
    });

    api.on("turn_start", () => {
      hasActiveWork = true;
      client.updateStatus("thinking");
    });

    api.on("tool_call", (event: any) => {
      const toolName =
        event?.toolName ||
        event?.tool ||
        event?.name ||
        (typeof event === "string" ? event : undefined);
      client.updateStatus("executing_tool", toolName);
    });

    api.on("message_end", (event: any) => {
      if (event?.message?.role === "assistant" || event?.role === "assistant") {
        const content = event?.message?.content || event?.content;
        if (typeof content === "string" && content.trim()) {
          lastFullOutput = content.trim();
          lastSummary = content.trim().slice(0, 300);
        } else if (Array.isArray(content)) {
          const textPart = content.find((p: any) => p?.type === "text" && p?.text);
          if (textPart?.text) {
            lastFullOutput = textPart.text.trim();
            lastSummary = textPart.text.trim().slice(0, 300);
          }
        }
      }
    });

    api.on("turn_end", () => {
      client.updateStatus("idle");
    });

    const handleSettleOrEnd = () => {
      if (hasActiveWork || currentTaskId) {
        if (activePiApiTask) {
          client.completeTask({
            taskId: activePiApiTask.taskId,
            summary: lastSummary,
            output: lastFullOutput || lastSummary,
            completedAt: new Date().toISOString(),
          });
        }
        activePiApiTask = null;
        currentTaskId = null;
        hasActiveWork = false;
        lastSummary = "Task execution finished.";
        lastFullOutput = "";
      }
    };

    api.on("agent_end", handleSettleOrEnd);
    api.on("agent_settled", handleSettleOrEnd);

    api.on("session_shutdown", () => {
      client.disconnect();
    });

    // Auto-connect to gateway
    client.connect().catch((err) => {
      console.warn("[pi-bridge] Could not connect to gateway:", err?.message || err);
    });

    return client;
  };
}

const defaultExtension = createPiExtension();
export default defaultExtension;
export { PiBridgeClient };
