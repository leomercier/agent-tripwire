export type ConditionType = "cross" | "up" | "down";

export interface Listener {
  id: string;
  asset: string;         // "BTC/USD"
  pythSymbol: string;    // "Crypto.BTC/USD"
  condition: ConditionType;
  value: number;         // absolute price (cross) or decimal fraction (up/down: 0.10 = 10%)
  timeWindowMs: number | null; // null = snapshot fixed at registration
  triggerCmd: string | null;
  agentPrompt: string | null;
  once: boolean;
  // Runtime state (set by daemon on registration)
  snapshotPrice: number;
  snapshotTime: number;
  lastPrice: number;
}

// Messages sent from CLI → daemon over Unix socket
export type IpcCommand =
  | { cmd: "ping" }
  | { cmd: "register"; listener: Omit<Listener, "snapshotPrice" | "snapshotTime" | "lastPrice"> }
  | { cmd: "list" }
  | { cmd: "kill"; listenerId?: string; asset?: string }
  | { cmd: "price"; asset: string };

export interface IpcResponse {
  ok: boolean;
  error?: string;
  data?: unknown;
}

// Pyth SSE tick
export interface PythTick {
  symbol: string;  // "Crypto.BTC/USD"
  price: number;
  timestamp: number; // unix seconds
}
