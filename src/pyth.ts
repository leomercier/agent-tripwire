/**
 * Pyth Network price stream adapter.
 * Uses the TradingView shim: https://benchmarks.pyth.network/v1/shims/tradingview
 *
 * SSE stream emits newline-delimited JSON: { id: "Crypto.BTC/USD", p: 72000.5, t: 1234567890 }
 * One global connection covers all symbols simultaneously — no per-asset subscriptions.
 */

import { EventEmitter } from "events";
import * as readline from "readline";
import type { PythTick } from "./types.js";

const API = "https://benchmarks.pyth.network/v1/shims/tradingview";
const STREAMING_URL = `${API}/streaming`;

// Known asset → Pyth symbol mappings
const SYMBOL_MAP: Record<string, string> = {
  BTC: "Crypto.BTC/USD",
  ETH: "Crypto.ETH/USD",
  SOL: "Crypto.SOL/USD",
  AVAX: "Crypto.AVAX/USD",
  BNB: "Crypto.BNB/USD",
  ADA: "Crypto.ADA/USD",
  DOT: "Crypto.DOT/USD",
  DOGE: "Crypto.DOGE/USD",
  XRP: "Crypto.XRP/USD",
  MATIC: "Crypto.MATIC/USD",
  LINK: "Crypto.LINK/USD",
  UNI: "Crypto.UNI/USD",
  NEAR: "Crypto.NEAR/USD",
  AAVE: "Crypto.AAVE/USD",
  ATOM: "Crypto.ATOM/USD",
  LTC: "Crypto.LTC/USD",
  FIL: "Crypto.FIL/USD",
  BCH: "Crypto.BCH/USD",
  TAO: "Crypto.TAO/USD",
  HYPE: "Crypto.HYPE/USD",
};

/**
 * Convert user-facing asset string to Pyth symbol.
 * "BTC/USD" → "Crypto.BTC/USD"
 * "BTC-PERP" → "Crypto.BTC/USD"
 */
export function toPythSymbol(asset: string): string | null {
  const coin = asset.split(/[-/]/)[0].toUpperCase();
  return SYMBOL_MAP[coin] ?? null;
}

/**
 * Fetch OHLC bars from Pyth REST API.
 * Chunks the range into 3-day segments to stay within API limits.
 */
export async function fetchHistoricalBars(
  asset: string,
  resolution: string,  // "1", "5", "60", "D" etc. (Pyth/TV format)
  from: number,        // unix seconds
  to: number
): Promise<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>> {
  const pythSymbol = toPythSymbol(asset);
  if (!pythSymbol) throw new Error(`Unsupported asset: ${asset}`);

  const MAX_CHUNK = 3 * 24 * 60 * 60; // 3 days in seconds
  const bars: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> = [];
  const seen = new Set<number>();
  const totalChunks = Math.ceil((to - from) / MAX_CHUNK);
  let chunkCount = 0;

  let cursor = from;
  while (cursor < to) {
    const chunkTo = Math.min(to, cursor + MAX_CHUNK);
    chunkCount++;
    updateProgressBar(chunkCount, totalChunks);

    const url = `${API}/history?symbol=${pythSymbol}&from=${cursor}&to=${chunkTo}&resolution=${resolution}`;

    const res = await fetch(url);
    const data = await res.json() as { t?: number[]; o?: number[]; h?: number[]; l?: number[]; c?: number[]; v?: number[]; errmsg?: string };

    if (data.errmsg) throw new Error(data.errmsg);

    if (data.t && data.t.length > 0) {
      for (let i = 0; i < data.t.length; i++) {
        const ts = data.t[i] * 1000;
        if (!seen.has(ts)) {
          seen.add(ts);
          bars.push({
            time: ts,
            open: data.o![i],
            high: data.h![i],
            low: data.l![i],
            close: data.c![i],
            volume: data.v?.[i] ?? 0,
          });
        }
      }
    }

    if (chunkTo < to) await new Promise(r => setTimeout(r, 200));
    cursor = chunkTo;
  }

  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);

  bars.sort((a, b) => a.time - b.time);
  return bars;
}

function updateProgressBar(current: number, total: number) {
  const pct = Math.round((current / total) * 100);
  const filled = Math.round((30 * current) / total);
  const bar = "█".repeat(filled) + "░".repeat(30 - filled);
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(`[${bar}] ${pct}% | chunk ${current}/${total}`);
}

/**
 * Global Pyth SSE stream.
 * Emits "tick" events with PythTick payloads.
 * Call .start() once; all symbol consumers share this connection.
 */
export class PythStream extends EventEmitter {
  private running = false;
  private reconnects = 0;
  private readonly maxReconnects = 10;
  private abortController: AbortController | null = null;

  start() {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop() {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  private async connect() {
    this.abortController = new AbortController();

    try {
      const res = await fetch(STREAMING_URL, { signal: this.abortController.signal });
      if (!res.body) throw new Error("No response body");

      this.reconnects = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (this.running) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // keep incomplete last line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const raw = JSON.parse(trimmed) as { id?: string; p?: number; t?: number };
            if (raw.id && raw.p !== undefined && raw.t !== undefined) {
              const tick: PythTick = {
                symbol: raw.id,
                price: raw.p,
                timestamp: raw.t,
              };
              this.emit("tick", tick);
            }
          } catch {
            // Partial JSON line — skip
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      console.error("[PythStream] Connection error:", (err as Error).message);
    }

    if (!this.running) return;

    // Reconnect with backoff
    if (this.reconnects < this.maxReconnects) {
      const delay = Math.min(1000 * 2 ** this.reconnects, 30_000);
      this.reconnects++;
      console.error(`[PythStream] Reconnecting in ${delay}ms (attempt ${this.reconnects})...`);
      setTimeout(() => this.connect(), delay);
    } else {
      console.error("[PythStream] Max reconnection attempts reached. Giving up.");
      this.emit("fatal");
    }
  }
}

/**
 * Fetch current price for a single asset by opening the SSE stream
 * and returning the first tick price for that symbol.
 */
export function fetchCurrentPrice(asset: string, timeoutMs = 10_000): Promise<number | null> {
  const pythSymbol = toPythSymbol(asset);
  if (!pythSymbol) return Promise.resolve(null);

  return new Promise((resolve) => {
    const stream = new PythStream();
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; stream.stop(); resolve(null); }
    }, timeoutMs);

    stream.on("tick", (tick: PythTick) => {
      if (tick.symbol !== pythSymbol || settled) return;
      settled = true;
      clearTimeout(timer);
      stream.stop();
      resolve(tick.price);
    });

    stream.start();
  });
}
