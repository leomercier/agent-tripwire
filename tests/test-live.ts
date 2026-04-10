/**
 * Live BTC data test — run with: npx tsx test-live.ts
 *
 * Hits Pyth Network for real prices. No daemon needed.
 *
 * Tests:
 *   1. fetchCurrentPrice  — REST round-trip
 *   2. PythStream         — SSE stream delivers ticks within 10s
 *   3. evaluate()         — cross condition fired against live price
 *   4. execTrigger()      — trigger runs with the real price in TW_PRICE
 */

import { fetchCurrentPrice, PythStream, toPythSymbol } from "../src/pyth.js";
import { evaluate } from "../src/conditions.js";
import { execTrigger } from "../src/actions.js";
import type { Listener, PythTick } from "../src/types.js";

// ─── Harness ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

// ─── 1. fetchCurrentPrice ────────────────────────────────────────────────────

section("1. fetchCurrentPrice — BTC/USD REST");
const btcPrice = await fetchCurrentPrice("BTC/USD");

assert("returned a number", btcPrice !== null);
assert("price > 0", (btcPrice ?? 0) > 0);
assert("price looks like BTC (>1k)", (btcPrice ?? 0) > 1_000);
console.log(`  → live BTC price: $${btcPrice?.toLocaleString()}`);

if (btcPrice === null) {
  console.error("Cannot continue without a live price — aborting.");
  process.exit(1);
}

// ─── 2. PythStream — receive at least 3 BTC ticks ───────────────────────────

section("2. PythStream — SSE ticks");

const PYTH_SYMBOL = "Crypto.BTC/USD";
const TICK_GOAL = 3;
const TIMEOUT_MS = 15_000;

const ticks: PythTick[] = [];

await new Promise<void>((resolve, reject) => {
  const stream = new PythStream();
  const timer = setTimeout(() => {
    stream.stop();
    reject(
      new Error(
        `Timed out after ${TIMEOUT_MS}ms — only received ${ticks.length} BTC tick(s)`
      )
    );
  }, TIMEOUT_MS);

  stream.on("tick", (tick: PythTick) => {
    if (tick.symbol !== PYTH_SYMBOL) return;
    ticks.push(tick);
    process.stdout.write(
      `  tick ${ticks.length}: $${tick.price.toLocaleString()} (t=${tick.timestamp})\n`
    );
    if (ticks.length >= TICK_GOAL) {
      clearTimeout(timer);
      stream.stop();
      resolve();
    }
  });

  stream.start();
});

assert(`received ≥ ${TICK_GOAL} BTC ticks`, ticks.length >= TICK_GOAL);
assert(
  "all ticks have price > 0",
  ticks.every((t) => t.price > 0)
);
assert(
  "all ticks have a timestamp",
  ticks.every((t) => t.timestamp > 0)
);
assert(
  "prices are in reasonable range",
  ticks.every((t) => t.price > 1_000 && t.price < 10_000_000)
);

// Prices shouldn't jump more than 5% between consecutive ticks
const maxJump = ticks.slice(1).reduce((max, t, i) => {
  const pct = Math.abs(t.price - ticks[i].price) / ticks[i].price;
  return Math.max(max, pct);
}, 0);
assert("no wild price jumps between ticks (< 5%)", maxJump < 0.05);

// ─── 3. evaluate() with live price ──────────────────────────────────────────

section("3. evaluate — cross condition against live price");

const livePrice = ticks[ticks.length - 1].price;
const crossAbove = livePrice * 1.0001; // 0.01% above current
const crossBelow = livePrice * 0.9999; // 0.01% below current

function makeListener(overrides: Partial<Listener> = {}): Listener {
  return {
    id: "live-test",
    asset: "BTC/USD",
    pythSymbol: PYTH_SYMBOL,
    condition: "cross",
    value: crossAbove,
    timeWindowMs: null,
    triggerCmd: null,
    agentPrompt: null,
    once: true,
    snapshotPrice: livePrice,
    snapshotTime: Date.now(),
    lastPrice: 0,
    ...overrides
  };
}

// Simulate: was just below threshold, new tick is at or above → should fire
const lCross = makeListener({ value: crossAbove, lastPrice: crossBelow });
const rCross = evaluate(lCross, crossAbove);
assert("cross fires when price moves above threshold", rCross.fired);

// Simulate: up 1% from live price
const lUp = makeListener({
  condition: "up",
  value: 0.01,
  snapshotPrice: livePrice,
  lastPrice: livePrice
});
assert("up does not fire at current price", !evaluate(lUp, livePrice).fired);
assert(
  "up fires at +1% of live price",
  evaluate(lUp, livePrice + livePrice * 0.01 + 1).fired
);

// Simulate: down 1% from live price
const lDown = makeListener({
  condition: "down",
  value: 0.01,
  snapshotPrice: livePrice,
  lastPrice: livePrice
});
assert(
  "down does not fire at current price",
  !evaluate(lDown, livePrice).fired
);
assert(
  "down fires at -1% of live price",
  evaluate(lDown, livePrice - livePrice * 0.01 - 1).fired
);

console.log(`  → live price used: $${livePrice.toLocaleString()}`);

// ─── 4. execTrigger with live price ─────────────────────────────────────────

section("4. execTrigger — real price in env vars");

const tmpFile = `/tmp/tw_live_test_${Date.now()}.txt`;
const listener = makeListener({
  triggerCmd: `printf "ASSET=%s PRICE=%s" "$TW_ASSET" "$TW_PRICE" > ${tmpFile}`,
  condition: "cross",
  value: crossAbove,
  lastPrice: crossBelow
});

execTrigger(listener, livePrice);

const { readFileSync, unlinkSync } = await import("fs");
let output = "";
try {
  output = readFileSync(tmpFile, "utf8").trim();
} catch {
  /* file missing */
}
try {
  unlinkSync(tmpFile);
} catch {
  /* ignore */
}

assert("trigger output file created", output.length > 0);
assert("TW_ASSET is BTC/USD", output.includes("ASSET=BTC/USD"));
assert("TW_PRICE matches live price", output.includes(`PRICE=${livePrice}`));

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
