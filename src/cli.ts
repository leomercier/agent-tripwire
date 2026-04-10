#!/usr/bin/env node
/**
 * hl — Hyperliquid/Pyth price event watcher
 *
 * Usage:
 *   hl price --asset BTC/USD
 *   hl event --asset BTC/USD --cross 72000 --trigger "notify-send 'BTC 72k'"
 *   hl event --asset BTC/USD --up 10% --time 1h --agent "BTC up, review TAO position"
 *   hl event --asset BTC/USD --down 5% --time 1d --trigger "./scripts/hedge.sh"
 *   hl list
 *   hl kill <listener-id>
 *   hl kill --asset BTC/USD
 */

import { Command } from "commander";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import { randomUUID } from "crypto";
import fs from "fs";
import { toPythSymbol, fetchCurrentPrice, fetchHistoricalBars } from "./pyth.js";
import { parsePct, parseTimeWindow } from "./conditions.js";
import { sendCommand, isDaemonRunning, SOCKET_PATH, ensureDirs } from "./ipc.js";
import type { Listener } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Daemon management ───────────────────────────────────────────────────────

async function ensureDaemon(): Promise<void> {
  if (await isDaemonRunning()) return;

  console.log("Starting hl daemon...");
  ensureDirs();

  const daemonScript = path.join(__dirname, "daemon.js");
  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Wait for daemon to be ready (up to 5s)
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    if (await isDaemonRunning()) return;
  }
  throw new Error("Daemon failed to start. Check ~/.tripwire/logs/daemon.log");
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("atw")
  .description("Pyth Network price event watcher")
  .version("1.0.0");

// ── hl price ─────────────────────────────────────────────────────────────────
program
  .command("price")
  .description("Get current price for an asset")
  .requiredOption("--asset <symbol>", "Asset symbol, e.g. BTC/USD")
  .action(async (opts: { asset: string }) => {
    // Try daemon first (has stream cache), fall back to REST
    if (await isDaemonRunning()) {
      try {
        const res = await sendCommand({ cmd: "price", asset: opts.asset });
        if (res.ok && res.data) {
          const d = res.data as { price: number; source: string };
          console.log(`${opts.asset}: $${d.price.toLocaleString()} (${d.source})`);
          return;
        }
      } catch { /* fall through to REST */ }
    }

    const price = await fetchCurrentPrice(opts.asset);
    if (price === null) {
      console.error(`Error: Could not fetch price for ${opts.asset}`);
      process.exit(1);
    }
    console.log(`${opts.asset}: $${price.toLocaleString()} (rest)`);
  });

// ── hl event ─────────────────────────────────────────────────────────────────
program
  .command("event")
  .description("Register a price event listener")
  .requiredOption("--asset <symbol>", "Asset symbol, e.g. BTC/USD")
  // Condition flags (one required)
  .option("--cross <price>", "Fire when price crosses this absolute value")
  .option("--up <pct>", "Fire when price rises by this % from snapshot, e.g. 10%")
  .option("--down <pct>", "Fire when price falls by this % from snapshot, e.g. 5%")
  // Window
  .option("--time <window>", "Rolling window for % conditions: 1m, 1h, 1d")
  // Actions
  .option("--trigger <cmd>", "Shell command to execute when condition fires")
  .option("--agent <prompt>", "Prompt to send to openclaw agent when condition fires")
  // Lifecycle
  .option("--once", "Remove listener after first fire (default for --cross)")
  .option("--repeat", "Keep listener alive after firing (default for --up/--down with --time)")
  .action(async (opts: {
    asset: string;
    cross?: string;
    up?: string;
    down?: string;
    time?: string;
    trigger?: string;
    agent?: string;
    once?: boolean;
    repeat?: boolean;
  }) => {
    // Validate asset
    const pythSymbol = toPythSymbol(opts.asset);
    if (!pythSymbol) {
      console.error(`Error: Unknown asset "${opts.asset}". Supported: BTC, ETH, SOL, AVAX, BNB, ADA, DOT, DOGE, XRP, MATIC, LINK, UNI, NEAR, AAVE, ATOM, LTC, FIL, BCH, TAO, HYPE`);
      process.exit(1);
    }

    // Validate exactly one condition
    const conditionCount = [opts.cross, opts.up, opts.down].filter(Boolean).length;
    if (conditionCount === 0) {
      console.error("Error: Provide one of --cross, --up, or --down");
      process.exit(1);
    }
    if (conditionCount > 1) {
      console.error("Error: Only one condition per listener (--cross, --up, or --down)");
      process.exit(1);
    }

    // Validate action
    if (!opts.trigger && !opts.agent) {
      console.error("Error: Provide at least one of --trigger or --agent");
      process.exit(1);
    }

    // Parse condition
    let condition: Listener["condition"];
    let value: number;

    if (opts.cross !== undefined) {
      condition = "cross";
      value = parseFloat(opts.cross);
      if (isNaN(value)) { console.error("Error: --cross must be a number"); process.exit(1); }
    } else if (opts.up !== undefined) {
      condition = "up";
      value = parsePct(opts.up);
    } else {
      condition = "down";
      value = parsePct(opts.down!);
    }

    // Parse time window
    let timeWindowMs: number | null = null;
    if (opts.time) {
      try { timeWindowMs = parseTimeWindow(opts.time); }
      catch (e) { console.error(`Error: ${(e as Error).message}`); process.exit(1); }
    }

    // Determine once/repeat defaults
    const once = opts.once ?? (condition === "cross" && !opts.repeat)
      ? true
      : !(opts.repeat ?? false);

    const listener: Omit<Listener, "snapshotPrice" | "snapshotTime" | "lastPrice"> = {
      id: randomUUID(),
      asset: opts.asset,
      pythSymbol,
      condition,
      value,
      timeWindowMs,
      triggerCmd: opts.trigger ?? null,
      agentPrompt: opts.agent ?? null,
      once,
    };

    await ensureDaemon();

    const res = await sendCommand({ cmd: "register", listener });
    if (!res.ok) {
      console.error("Error registering listener:", res.error);
      process.exit(1);
    }

    const d = res.data as { id: string; snapshotPrice: number };
    console.log(`✓ Listener registered`);
    console.log(`  ID:        ${d.id}`);
    console.log(`  Asset:     ${opts.asset}`);
    console.log(`  Condition: ${condition} ${condition === "cross" ? value : (value * 100).toFixed(2) + "%"}`);
    if (timeWindowMs) console.log(`  Window:    ${opts.time}`);
    console.log(`  Snapshot:  $${d.snapshotPrice.toLocaleString()}`);
    console.log(`  Once:      ${once}`);
    if (opts.trigger) console.log(`  Trigger:   ${opts.trigger}`);
    if (opts.agent) console.log(`  Agent:     ${opts.agent}`);
  });

// ── hl list ──────────────────────────────────────────────────────────────────
program
  .command("list")
  .description("List all active listeners")
  .action(async () => {
    if (!await isDaemonRunning()) {
      console.log("No daemon running — no active listeners.");
      return;
    }

    const res = await sendCommand({ cmd: "list" });
    if (!res.ok) { console.error("Error:", res.error); process.exit(1); }

    const items = res.data as Array<Record<string, unknown>>;
    if (items.length === 0) { console.log("No active listeners."); return; }

    console.log(`\n${items.length} active listener(s):\n`);
    for (const l of items) {
      const valueFmt = l.condition === "cross"
        ? `$${l.value}`
        : `${((l.value as number) * 100).toFixed(2)}%`;
      const window = l.timeWindowMs ? ` / ${l.timeWindowMs}ms window` : "";
      console.log(`  ${l.id}`);
      console.log(`    ${l.asset} ${l.condition} ${valueFmt}${window}`);
      console.log(`    snapshot: $${l.snapshotPrice}  last: $${l.lastPrice}`);
      if (l.triggerCmd) console.log(`    trigger: ${l.triggerCmd}`);
      if (l.agentPrompt) console.log(`    agent: ${l.agentPrompt}`);
      console.log();
    }
  });

// ── hl kill ──────────────────────────────────────────────────────────────────
program
  .command("kill [id]")
  .description("Kill a listener by ID, or all listeners for an asset")
  .option("--asset <symbol>", "Kill all listeners for this asset")
  .action(async (id: string | undefined, opts: { asset?: string }) => {
    if (!id && !opts.asset) {
      console.error("Error: Provide a listener ID or --asset");
      process.exit(1);
    }

    if (!await isDaemonRunning()) {
      console.log("No daemon running.");
      return;
    }

    const res = await sendCommand({
      cmd: "kill",
      listenerId: id,
      asset: opts.asset,
    });

    if (!res.ok) { console.error("Error:", res.error); process.exit(1); }
    const d = res.data as { removed: number };
    console.log(`Removed ${d.removed} listener(s).`);
  });

// ── tw history ───────────────────────────────────────────────────────────────
program
  .command("history")
  .description("Download historical OHLCV bars to CSV")
  .requiredOption("--asset <symbol>", "Asset symbol, e.g. BTC/USD")
  .requiredOption("--from <date>", "Start date (YYYY-MM-DD or Unix timestamp in seconds)")
  .requiredOption("--to <date>", "End date (YYYY-MM-DD or Unix timestamp in seconds)")
  .option("--interval <interval>", "Bar interval: 1m, 5m, 15m, 30m, 1h, 4h, 1d", "1h")
  .option("--output <path>", "Output CSV path (default: {asset}-{from}-{to}.csv)")
  .action(async (opts: { asset: string; from: string; to: string; interval: string; output?: string }) => {
    // Validate asset
    const pythSymbol = toPythSymbol(opts.asset);
    if (!pythSymbol) {
      console.error(`Error: Unknown asset "${opts.asset}"`);
      process.exit(1);
    }

    // Parse from/to — accept YYYY-MM-DD or integer unix seconds
    function parseDate(raw: string): number {
      if (/^\d+$/.test(raw)) return parseInt(raw, 10);
      const ms = Date.parse(raw);
      if (isNaN(ms)) { console.error(`Error: Cannot parse date "${raw}"`); process.exit(1); }
      return Math.floor(ms / 1000);
    }
    const fromSec = parseDate(opts.from);
    const toSec   = parseDate(opts.to);
    if (fromSec >= toSec) {
      console.error("Error: --from must be before --to");
      process.exit(1);
    }

    // Convert interval to Pyth resolution string
    function toResolution(interval: string): string {
      const unit = interval.slice(-1).toLowerCase();
      const n    = parseInt(interval.slice(0, -1), 10);
      if (isNaN(n)) { console.error(`Error: Cannot parse interval "${interval}"`); process.exit(1); }
      switch (unit) {
        case "m": return String(n);
        case "h": return String(n * 60);
        case "d": return "D";
        default:  console.error(`Error: Unknown interval unit "${unit}". Use m, h, or d.`); process.exit(1);
      }
    }
    const resolution = toResolution(opts.interval);

    // Build output filename: ./data/BTC-USD-2024-01-01-2024-12-31.csv
    const assetSlug = opts.asset.replace("/", "-");
    const fromStr   = new Date(fromSec * 1000).toISOString().slice(0, 10);
    const toStr     = new Date(toSec   * 1000).toISOString().slice(0, 10);
    const dataDir   = path.join(process.cwd(), "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const outPath   = opts.output ?? path.join(dataDir, `${assetSlug}-${fromStr}-${toStr}.csv`);

    console.log(`Downloading ${opts.asset} ${opts.interval} bars from ${fromStr} to ${toStr}...`);

    let bars: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
    try {
      bars = await fetchHistoricalBars(opts.asset, resolution, fromSec, toSec);
    } catch (err) {
      console.error("Error fetching historical data:", (err as Error).message);
      process.exit(1);
    }

    if (bars.length === 0) {
      console.error("No data returned for the requested range.");
      process.exit(1);
    }

    // Write CSV
    const header = "timestamp,datetime,open,high,low,close,volume\n";
    const rows = bars.map(b => {
      const dt = new Date(b.time).toISOString();
      return `${b.time},${dt},${b.open},${b.high},${b.low},${b.close},${b.volume}`;
    }).join("\n");

    fs.writeFileSync(outPath, header + rows + "\n");
    console.log(`\nSaved ${bars.length} bars to ${outPath}`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
