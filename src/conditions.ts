import type { Listener } from "./types.js";

export interface FireResult {
  fired: boolean;
  pctChange?: number;
}

/**
 * Evaluate a listener against the latest price tick.
 * Returns { fired: true } when the condition is met.
 * Mutates listener.snapshotPrice/snapshotTime when the rolling window resets,
 * and listener.lastPrice on every call.
 */
export function evaluate(listener: Listener, currentPrice: number): FireResult {
  const prev = listener.lastPrice;
  listener.lastPrice = currentPrice;

  // Roll snapshot if time window has elapsed
  if (listener.timeWindowMs !== null) {
    const elapsed = Date.now() - listener.snapshotTime;
    if (elapsed >= listener.timeWindowMs) {
      listener.snapshotPrice = currentPrice;
      listener.snapshotTime = Date.now();
      return { fired: false }; // Reset — don't fire on the window boundary itself
    }
  }

  switch (listener.condition) {
    case "cross": {
      // Fires when price crosses value in either direction
      if (prev === 0) return { fired: false }; // No previous price yet
      const crossedUp = prev < listener.value && currentPrice >= listener.value;
      const crossedDown = prev > listener.value && currentPrice <= listener.value;
      return { fired: crossedUp || crossedDown };
    }

    case "up": {
      if (listener.snapshotPrice === 0) return { fired: false };
      const pct = (currentPrice - listener.snapshotPrice) / listener.snapshotPrice;
      return { fired: pct >= listener.value, pctChange: pct };
    }

    case "down": {
      if (listener.snapshotPrice === 0) return { fired: false };
      const pct = (listener.snapshotPrice - currentPrice) / listener.snapshotPrice;
      return { fired: pct >= listener.value, pctChange: -pct };
    }

    default:
      return { fired: false };
  }
}

/**
 * Parse a percentage string like "10%" → 0.10
 */
export function parsePct(raw: string): number {
  return parseFloat(raw.replace("%", "")) / 100;
}

/**
 * Parse a time window string: "1m" → 60000ms, "1h" → 3600000ms, "1d" → 86400000ms
 */
export function parseTimeWindow(raw: string): number {
  const unit = raw.slice(-1).toLowerCase();
  const n = parseFloat(raw.slice(0, -1));
  switch (unit) {
    case "m": return n * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    case "d": return n * 24 * 60 * 60 * 1000;
    default:  throw new Error(`Unknown time unit: ${unit}. Use m, h, or d.`);
  }
}
