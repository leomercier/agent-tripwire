/**
 * hl daemon process
 * Spawned detached by the CLI on first `hl event` invocation.
 * Manages:
 *   - One global Pyth SSE stream (all symbols)
 *   - All active listeners and their condition state
 *   - Unix socket server for CLI ↔ daemon IPC
 */

import net from "net";
import fs from "fs";
import { randomUUID } from "crypto";
import { PythStream, toPythSymbol, fetchCurrentPrice } from "./pyth.js";
import { evaluate } from "./conditions.js";
import { fireListener } from "./actions.js";
import { SOCKET_PATH, STATE_PATH, LOG_DIR, ensureDirs, writeResponse } from "./ipc.js";
import type { Listener, IpcCommand, PythTick } from "./types.js";

// ─── State ───────────────────────────────────────────────────────────────────

const listeners = new Map<string, Listener>(); // id → Listener
const latestPrices = new Map<string, number>();  // pythSymbol → latest price

function saveState() {
  const data = {
    pid: process.pid,
    listeners: Array.from(listeners.values()),
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(data, null, 2));
}

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(`${LOG_DIR}/daemon.log`, line);
}

// ─── Pyth stream ─────────────────────────────────────────────────────────────

const stream = new PythStream();

stream.on("tick", (tick: PythTick) => {
  latestPrices.set(tick.symbol, tick.price);
  evaluateAll(tick.symbol, tick.price);
});

stream.on("fatal", () => {
  log("Pyth stream fatal — no more reconnects. Daemon will keep listeners but prices are stale.");
});

function evaluateAll(pythSymbol: string, price: number) {
  for (const [id, listener] of listeners) {
    if (listener.pythSymbol !== pythSymbol) continue;

    const result = evaluate(listener, price);
    if (!result.fired) continue;

    log(`Listener ${id} fired: ${listener.condition} ${listener.asset} @ ${price}`);

    // Fire actions (blocking — keeps ordering clean; use child_process if you need async)
    setImmediate(() => {
      fireListener(listener, price, result.pctChange);

      if (listener.once) {
        listeners.delete(id);
        log(`Listener ${id} removed (--once)`);
        saveState();

        // Stop stream if no listeners left
        if (listeners.size === 0) {
          log("No listeners remaining — shutting down daemon");
          stream.stop();
          server.close(() => process.exit(0));
        }
      }
    });
  }
}

// ─── IPC server ──────────────────────────────────────────────────────────────

// Clean up stale socket file if left from a previous crash
if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);

const server = net.createServer((socket) => {
  let raw = "";

  socket.on("data", (chunk) => {
    raw += chunk.toString();
    const idx = raw.indexOf("\n");
    if (idx === -1) return;

    const msg = raw.slice(0, idx);
    raw = raw.slice(idx + 1);

    let cmd: IpcCommand;
    try { cmd = JSON.parse(msg); }
    catch { writeResponse(socket, { ok: false, error: "Invalid JSON" }); return; }

    handleCommand(cmd, socket);
  });

  socket.on("error", () => { /* client disconnected early */ });
});

server.listen(SOCKET_PATH, () => {
  log(`Daemon started — PID ${process.pid}, socket: ${SOCKET_PATH}`);
  ensureDirs();
  saveState();
  stream.start();
});

async function handleCommand(cmd: IpcCommand, socket: net.Socket) {
  switch (cmd.cmd) {
    case "ping":
      writeResponse(socket, { ok: true, data: { pid: process.pid } });
      break;

    case "register": {
      const partial = cmd.listener;
      if (!partial) { writeResponse(socket, { ok: false, error: "Missing listener" }); return; }

      // Get current price for snapshot
      const currentPrice = latestPrices.get(partial.pythSymbol)
        ?? await fetchCurrentPrice(partial.asset)
        ?? 0;

      const listener: Listener = {
        ...partial,
        snapshotPrice: currentPrice,
        snapshotTime: Date.now(),
        lastPrice: currentPrice,
      };

      listeners.set(listener.id, listener);
      saveState();
      log(`Registered listener ${listener.id}: ${listener.condition} ${listener.asset}`);
      writeResponse(socket, { ok: true, data: { id: listener.id, snapshotPrice: currentPrice } });
      break;
    }

    case "list":
      writeResponse(socket, {
        ok: true,
        data: Array.from(listeners.values()).map(l => ({
          id: l.id,
          asset: l.asset,
          condition: l.condition,
          value: l.value,
          timeWindowMs: l.timeWindowMs,
          once: l.once,
          snapshotPrice: l.snapshotPrice,
          lastPrice: l.lastPrice,
          triggerCmd: l.triggerCmd,
          agentPrompt: l.agentPrompt,
        })),
      });
      break;

    case "kill": {
      let removed = 0;
      if (cmd.listenerId) {
        if (listeners.delete(cmd.listenerId)) removed = 1;
      } else if (cmd.asset) {
        for (const [id, l] of listeners) {
          if (l.asset === cmd.asset) { listeners.delete(id); removed++; }
        }
      }
      saveState();
      writeResponse(socket, { ok: true, data: { removed } });

      if (listeners.size === 0) {
        log("No listeners remaining after kill — shutting down daemon");
        setImmediate(() => { stream.stop(); server.close(() => process.exit(0)); });
      }
      break;
    }

    case "price": {
      const pythSym = toPythSymbol(cmd.asset);
      if (!pythSym) { writeResponse(socket, { ok: false, error: `Unknown asset: ${cmd.asset}` }); return; }
      const cached = latestPrices.get(pythSym);
      if (cached !== undefined) {
        writeResponse(socket, { ok: true, data: { price: cached, source: "stream" } });
      } else {
        const price = await fetchCurrentPrice(cmd.asset);
        if (price === null) { writeResponse(socket, { ok: false, error: "Price unavailable" }); return; }
        writeResponse(socket, { ok: true, data: { price, source: "rest" } });
      }
      break;
    }

    default:
      writeResponse(socket, { ok: false, error: "Unknown command" });
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.on("SIGTERM", () => {
  log("Received SIGTERM — shutting down");
  stream.stop();
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  log("Received SIGINT — shutting down");
  stream.stop();
  server.close(() => process.exit(0));
});
