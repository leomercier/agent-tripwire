import { execSync } from "child_process";
import fs from "fs";
import type { Listener } from "./types.js";
import { ALERTS_QUEUE_PATH, ALERTS_ACK_PATH } from "./ipc.js";

const OPENCLAW_BIN = process.env.TW_OPENCLAW_BIN ?? "openclaw";

function buildAlertId(asset: string, firedAt: string): string {
  return `tripwire:${asset}:${firedAt}`;
}

/**
 * Build the env vars injected into --trigger shell commands
 */
function buildEnv(listener: Listener, currentPrice: number, firedAt: string, pctChange?: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TW_ASSET: listener.asset,
    TW_PRICE: String(currentPrice),
    TW_CONDITION: listener.condition,
    TW_PCT_CHANGE: pctChange !== undefined ? (pctChange * 100).toFixed(4) : "",
    TW_LISTENER_ID: listener.id,
    TW_FIRED_AT: firedAt,
  };
}

/**
 * Write a JSONL alert record to the queue and ensure the ack file exists.
 * This is the primary delivery path — heartbeat polls the queue and surfaces
 * new alerts in the main session.
 */
function enqueueAlert(
  listener: Listener,
  currentPrice: number,
  firedAt: string,
  alertId: string,
  pctChange?: number,
): void {
  const record = JSON.stringify({
    type: "price_alert",
    asset: listener.asset,
    price: String(currentPrice),
    condition: listener.condition,
    pct_change: pctChange !== undefined ? (pctChange * 100).toFixed(4) : "",
    fired_at: firedAt,
    id: alertId,
  });

  try {
    fs.appendFileSync(ALERTS_QUEUE_PATH, record + "\n");
    if (!fs.existsSync(ALERTS_ACK_PATH)) {
      fs.writeFileSync(ALERTS_ACK_PATH, "");
    }
    console.log(`[actions] Alert queued: ${alertId}`);
  } catch (err) {
    console.error(`[actions] Failed to enqueue alert ${alertId}:`, (err as Error).message);
  }
}

/**
 * Execute a --trigger shell command
 */
export function execTrigger(listener: Listener, currentPrice: number, firedAt: string, pctChange?: number): void {
  if (!listener.triggerCmd) return;

  const env = buildEnv(listener, currentPrice, firedAt, pctChange);
  console.log(`[actions] Firing trigger for ${listener.id}: ${listener.triggerCmd}`);

  try {
    execSync(listener.triggerCmd, { env, stdio: "inherit", timeout: 30_000 });
  } catch (err) {
    console.error(`[actions] Trigger command failed for ${listener.id}:`, (err as Error).message);
    // Don't re-throw — trigger failure must not kill the daemon
  }
}

/**
 * Best-effort fallback delivery via openclaw agent with explicit session/agent targeting.
 * Uses TW_SESSION_ID env if set, otherwise targets --agent main.
 * The message is self-contained so it can be surfaced without additional context.
 */
export function callAgent(
  listener: Listener,
  currentPrice: number,
  firedAt: string,
  alertId: string,
  pctChange?: number,
): void {
  if (!listener.agentPrompt) return;

  const sessionId = process.env.TW_SESSION_ID;
  const pctStr = pctChange !== undefined ? ` (${(pctChange * 100).toFixed(4)}%)` : "";

  const message = [
    `TRIPWIRE ALERT`,
    ``,
    `Monitor: ${listener.asset} price tripwire`,
    `Trigger: ${listener.condition} threshold crossed`,
    `Current: $${currentPrice}${pctStr}`,
    `Fired at: ${firedAt}`,
    `Alert ID: ${alertId}`,
    ``,
    listener.agentPrompt,
  ].join("\n");

  const escaped = message.replace(/"/g, '\\"');
  const targetFlag = sessionId ? `--session-id "${sessionId}"` : `--agent main`;
  const cmd = `${OPENCLAW_BIN} agent ${targetFlag} --message "${escaped}" --deliver --local`;

  console.log(`[actions] Fallback delivery for ${listener.id} (target: ${sessionId ? `session ${sessionId}` : "main"})`);

  try {
    execSync(cmd, { stdio: "inherit", timeout: 120_000 });
  } catch (err) {
    console.error(`[actions] Agent call failed for ${listener.id}:`, (err as Error).message);
  }
}

export function fireListener(listener: Listener, currentPrice: number, pctChange?: number): void {
  const firedAt = new Date().toISOString();
  const alertId = buildAlertId(listener.asset, firedAt);

  // Primary: always enqueue for heartbeat delivery
  enqueueAlert(listener, currentPrice, firedAt, alertId, pctChange);

  // Trigger: shell command if configured
  execTrigger(listener, currentPrice, firedAt, pctChange);

  // Fallback: immediate best-effort delivery via openclaw agent
  callAgent(listener, currentPrice, firedAt, alertId, pctChange);
}
