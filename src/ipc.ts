import net from "net";
import os from "os";
import path from "path";
import fs from "fs";
import type { IpcCommand, IpcResponse } from "./types.js";

export const TW_DIR = path.join(os.homedir(), ".tripwire");
export const SOCKET_PATH = path.join(TW_DIR, "tw.sock");
export const STATE_PATH = path.join(TW_DIR, "state.json");
export const LOG_DIR = path.join(TW_DIR, "logs");

export function ensureDirs() {
  fs.mkdirSync(TW_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Send a command to the daemon and return the response.
 * Throws if daemon is not running or request times out.
 */
export function sendCommand(cmd: IpcCommand, timeoutMs = 5000): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    let raw = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; socket.destroy(); reject(new Error("Daemon timeout")); }
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(JSON.stringify(cmd) + "\n");
    });

    socket.on("data", (chunk) => {
      raw += chunk.toString();
      const idx = raw.indexOf("\n");
      if (idx !== -1) {
        clearTimeout(timer);
        socket.destroy();
        if (!settled) {
          settled = true;
          try { resolve(JSON.parse(raw.slice(0, idx))); }
          catch { reject(new Error("Bad daemon response")); }
        }
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(err); }
    });
  });
}

/**
 * Check if daemon is running by sending a ping.
 */
export async function isDaemonRunning(): Promise<boolean> {
  try {
    const res = await sendCommand({ cmd: "ping" }, 2000);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Write a response to a socket connection (daemon → CLI).
 */
export function writeResponse(socket: net.Socket, res: IpcResponse) {
  socket.write(JSON.stringify(res) + "\n");
}
