export type SessionState = "idle" | "thinking" | "executing_tool";

export interface SessionInfo {
  id: string;
  alias?: string;
  cwd: string;
  model?: string;
  state: SessionState;
  activeTool?: string;
  connectedAt: string;
  lastSeen: string;
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  text: string;
  taskId?: string;
  timestamp: string;
}

export type NudgeLevel = "info" | "warning" | "question" | "needs_action";

export interface ClientNudgeMessage {
  type: "nudge";
  sessionId: string;
  taskId: string;
  message: string;
  level?: NudgeLevel;
  data?: Record<string, unknown>;
  timestamp?: string;
}

export interface ServerSteerMessage {
  type: "steer";
  sessionId?: string;
  instruction: string;
  message?: string;
  targetTaskId?: string;
}

// Client -> Server messages
export type ClientMessage =
  | {
      type: "register";
      sessionId: string;
      alias?: string;
      cwd: string;
      model?: string;
    }
  | {
      type: "status_update";
      sessionId: string;
      state: SessionState;
      activeTool?: string;
    }
  | {
      type: "task_completed";
      sessionId: string;
      taskId?: string;
      summary: string;
      output?: string;
      completedAt: string;
    }
  | ClientNudgeMessage
  | {
      type: "message_logged";
      sessionId: string;
      message: SessionMessage;
    }
  | {
      type: "pong";
    };

// Server -> Client messages
export type ServerMessage =
  | {
      type: "prompt";
      taskId: string;
      prompt: string;
    }
  | ServerSteerMessage
  | {
      type: "interrupt";
    }
  | {
      type: "ping";
    };

// Gateway REST API contracts
export interface PostPromptRequest {
  prompt: string;
  webhookUrl?: string;
  webhookHeaders?: Record<string, string>;
  taskId?: string;
  notifyChatId?: string;
  notify_chat_id?: string;
  metadata?: {
    notify_chat_id?: string;
    notifyChatId?: string;
    [key: string]: any;
  };
}

export interface PostPromptResponse {
  accepted: boolean;
  sessionId: string;
  taskId: string;
  status: string;
}

export interface WebhookEventPayload {
  event: "pi_task_completed" | "pi_nudge";
  source: "pi-api";
  target?: "all" | "zeroclaw" | "picoclaw";
  sessionId: string;
  taskId: string;
  message: string;
  summary: string;
  output?: string;
  level?: NudgeLevel;
  metadata?: Record<string, unknown>;
  completedAt: string;
}

export interface ZeroClawWebhookPayload {
  event: "pi_task_completed" | "pi_nudge";
  source?: "pi-api";
  target?: "all" | "zeroclaw" | "picoclaw";
  message: string;
  sessionId: string;
  taskId: string;
  summary: string;
  output?: string;
  level?: NudgeLevel;
  metadata?: Record<string, unknown>;
  completedAt: string;
}

export interface PostSteerRequest {
  instruction: string;
  message?: string;
  targetTaskId?: string;
}

export interface PostSteerResponse {
  accepted: boolean;
  sessionId: string;
  status: string;
  targetTaskId?: string;
}

export interface PostNudgeRequest {
  message: string;
  taskId?: string;
  level?: NudgeLevel;
  data?: Record<string, unknown>;
}

export interface PostNudgeResponse {
  accepted: boolean;
  sessionId: string;
  taskId?: string;
  status: string;
}

export interface PostPromptSyncResponse {
  status: "completed" | "timeout" | "error";
  sessionId: string;
  taskId: string;
  output: string;
  completedAt?: string;
  error?: string;
}

export interface GetMessagesResponse {
  sessionId: string;
  alias?: string;
  total: number;
  messages: SessionMessage[];
}
