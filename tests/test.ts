/**
 * Tripwire test script — run with: npx tsx test.ts
 *
 * Tests:
 *   1. parsePct / parseTimeWindow (pure parsing)
 *   2. evaluate() — cross / up / down conditions
 *   3. execTrigger() — fires a real shell command and checks env vars are set
 */

import { evaluate, parsePct, parseTimeWindow } from "../src/conditions.js";
import { execTrigger } from "../src/actions.js";
import type { Listener } from "../src/types.js";

// ─── Tiny test harness ────────────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeListener(overrides: Partial<Listener> = {}): Listener {
  return {
    id: "test-id",
    asset: "BTC/USD",
    pythSymbol: "Crypto.BTC/USD",
    condition: "cross",
    value: 100_000,
    timeWindowMs: null,
    triggerCmd: null,
    agentPrompt: null,
    once: true,
    snapshotPrice: 90_000,
    snapshotTime: Date.now(),
    lastPrice: 0,
    ...overrides
  };
}

// ─── 1. Parsing ───────────────────────────────────────────────────────────────

section("1. parsePct");
assert("10%  → 0.10", parsePct("10%") === 0.1);
assert("5%   → 0.05", parsePct("5%") === 0.05);
assert("0.5% → 0.005", parsePct("0.5%") === 0.005);
assert("100% → 1.0", parsePct("100%") === 1.0);

section("2. parseTimeWindow");
assert("1m  → 60 000 ms", parseTimeWindow("1m") === 60_000);
assert("30m → 1 800 000 ms", parseTimeWindow("30m") === 1_800_000);
assert("1h  → 3 600 000 ms", parseTimeWindow("1h") === 3_600_000);
assert("1d  → 86 400 000 ms", parseTimeWindow("1d") === 86_400_000);
try {
  parseTimeWindow("1s");
  assert("invalid unit throws", false);
} catch {
  assert("invalid unit throws", true);
}

// ─── 2. evaluate() — cross ───────────────────────────────────────────────────

section("3. evaluate — cross");

{
  const l = makeListener({ condition: "cross", value: 100_000, lastPrice: 0 });

  // No lastPrice yet — should not fire
  assert("no fire when lastPrice=0", !evaluate(l, 99_000).fired);

  // Now lastPrice is set to 99_000 (by previous call); cross upward
  assert("fires crossing up through 100k", evaluate(l, 100_001).fired);

  // lastPrice is now 100_001; price drops back below — cross downward
  assert("fires crossing down through 100k", evaluate(l, 99_999).fired);

  // No cross — both sides below threshold
  const l2 = makeListener({
    condition: "cross",
    value: 100_000,
    lastPrice: 95_000
  });
  assert("no fire when price stays below", !evaluate(l2, 96_000).fired);

  // No cross — both sides above threshold
  const l3 = makeListener({
    condition: "cross",
    value: 100_000,
    lastPrice: 101_000
  });
  assert("no fire when price stays above", !evaluate(l3, 102_000).fired);

  // Exact hit on value counts as a cross
  const l4 = makeListener({
    condition: "cross",
    value: 100_000,
    lastPrice: 99_000
  });
  assert(
    "fires when price equals threshold exactly",
    evaluate(l4, 100_000).fired
  );
}

// ─── evaluate() — up ─────────────────────────────────────────────────────────

section("4. evaluate — up");

{
  // 10% up from 100_000 snapshot
  const l = makeListener({
    condition: "up",
    value: 0.1,
    snapshotPrice: 100_000,
    lastPrice: 100_000
  });

  assert("no fire at +9.9%", !evaluate(l, 109_999).fired);
  assert("fires at +10%", evaluate(l, 110_000).fired);
  assert("fires at +11%", evaluate(l, 111_000).fired);

  // pctChange is exposed
  const l2 = makeListener({
    condition: "up",
    value: 0.1,
    snapshotPrice: 100_000,
    lastPrice: 100_000
  });
  const r = evaluate(l2, 115_000);
  assert("pctChange ≈ 0.15", Math.abs((r.pctChange ?? 0) - 0.15) < 0.0001);
}

// ─── evaluate() — down ───────────────────────────────────────────────────────

section("5. evaluate — down");

{
  // 5% down from 80_000 snapshot
  const l = makeListener({
    condition: "down",
    value: 0.05,
    snapshotPrice: 80_000,
    lastPrice: 80_000
  });

  assert("no fire at -4.9%", !evaluate(l, 76_001).fired);
  assert("fires at -5%", evaluate(l, 76_000).fired);

  // pctChange should be negative
  const l2 = makeListener({
    condition: "down",
    value: 0.05,
    snapshotPrice: 80_000,
    lastPrice: 80_000
  });
  const r = evaluate(l2, 72_000);
  assert("pctChange ≈ -0.10", Math.abs((r.pctChange ?? 0) - -0.1) < 0.0001);
}

// ─── evaluate() — snapshot=0 guard ───────────────────────────────────────────

section("6. evaluate — zero snapshot guard");

{
  const lu = makeListener({
    condition: "up",
    value: 0.1,
    snapshotPrice: 0,
    lastPrice: 0
  });
  const ld = makeListener({
    condition: "down",
    value: 0.05,
    snapshotPrice: 0,
    lastPrice: 0
  });
  assert("up: no fire when snapshot=0", !evaluate(lu, 110_000).fired);
  assert("down: no fire when snapshot=0", !evaluate(ld, 70_000).fired);
}

// ─── evaluate() — rolling time window resets snapshot ────────────────────────

section("7. evaluate — time window reset");

{
  // Set snapshotTime far in the past so it's already elapsed
  const l = makeListener({
    condition: "up",
    value: 0.1,
    snapshotPrice: 100_000,
    snapshotTime: Date.now() - 10_000, // 10 s ago
    timeWindowMs: 5_000, // 5 s window → already elapsed
    lastPrice: 100_000
  });

  // Should reset (not fire) and update snapshot to current price
  const r = evaluate(l, 115_000);
  assert("no fire on window boundary — snapshot resets", !r.fired);
  assert("snapshot updated to current price", l.snapshotPrice === 115_000);
}

// ─── 3. execTrigger() ────────────────────────────────────────────────────────

section("8. execTrigger — shell command receives env vars");

{
  // Write TW_PRICE and TW_ASSET to a temp file, then read it back
  const tmpFile = `/tmp/tw_test_${Date.now()}.txt`;
  const listener = makeListener({
    triggerCmd: `printf "%s %s" "$TW_ASSET" "$TW_PRICE" > ${tmpFile}`,
    condition: "cross",
    value: 100_000
  });

  execTrigger(listener, 99_500);

  // Give the shell command a moment (execSync is synchronous, so this is instant)
  const { readFileSync } = await import("fs");
  let output = "";
  try {
    output = readFileSync(tmpFile, "utf8").trim();
  } catch {
    /* file missing */
  }

  assert("TW_ASSET set to BTC/USD", output.startsWith("BTC/USD"));
  assert("TW_PRICE set to 99500", output.includes("99500"));

  // Clean up
  try {
    (await import("fs")).unlinkSync(tmpFile);
  } catch {
    /* ignore */
  }
}

{
  // No triggerCmd — should be a no-op (no throw)
  const l = makeListener({ triggerCmd: null });
  try {
    execTrigger(l, 50_000);
    assert("no-op when triggerCmd=null", true);
  } catch {
    assert("no-op when triggerCmd=null", false);
  }
}

{
  // Failing command must not throw (daemon safety)
  const l = makeListener({ triggerCmd: "exit 1" });
  try {
    execTrigger(l, 50_000);
    assert("failing trigger swallowed gracefully", true);
  } catch {
    assert("failing trigger swallowed gracefully", false);
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
