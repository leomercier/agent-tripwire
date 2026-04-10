import { execSync } from "child_process";
import type { Listener } from "./types.js";

const OPENCLAW_BIN = process.env.TW_OPENCLAW_BIN ?? "openclaw";

/**
 * Build the env vars injected into --trigger shell commands
 */
function buildEnv(listener: Listener, currentPrice: number, pctChange?: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TW_ASSET: listener.asset,
    TW_PRICE: String(currentPrice),
    TW_CONDITION: listener.condition,
    TW_PCT_CHANGE: pctChange !== undefined ? (pctChange * 100).toFixed(4) : "",
    TW_LISTENER_ID: listener.id,
    TW_FIRED_AT: new Date().toISOString(),
  };
}

/**
 * Execute a --trigger shell command
 */
export function execTrigger(listener: Listener, currentPrice: number, pctChange?: number): void {
  if (!listener.triggerCmd) return;

  const env = buildEnv(listener, currentPrice, pctChange);
  console.log(`[actions] Firing trigger for ${listener.id}: ${listener.triggerCmd}`);

  try {
    execSync(listener.triggerCmd, { env, stdio: "inherit", timeout: 30_000 });
  } catch (err) {
    console.error(`[actions] Trigger command failed for ${listener.id}:`, (err as Error).message);
    // Don't re-throw — trigger failure must not kill the daemon
  }
}

/**
 * Forward to openclaw agent with assembled context
 */
export function callAgent(listener: Listener, currentPrice: number, pctChange?: number): void {
  if (!listener.agentPrompt) return;

  const ctx = [
    `TW_ASSET=${listener.asset}`,
    `TW_PRICE=${currentPrice}`,
    `TW_CONDITION=${listener.condition}`,
    pctChange !== undefined ? `TW_PCT_CHANGE=${(pctChange * 100).toFixed(4)}%` : "",
    `TW_FIRED_AT=${new Date().toISOString()}`,
  ].filter(Boolean).join(" ");

  const fullPrompt = `${ctx}\n\n${listener.agentPrompt}`;
  const escaped = fullPrompt.replace(/"/g, '\\"');
  const cmd = `${OPENCLAW_BIN} agent --message "${escaped}"`;

  console.log(`[actions] Calling agent for ${listener.id}`);

  try {
    execSync(cmd, { stdio: "inherit", timeout: 120_000 });
  } catch (err) {
    console.error(`[actions] Agent call failed for ${listener.id}:`, (err as Error).message);
  }
}

export function fireListener(listener: Listener, currentPrice: number, pctChange?: number): void {
  execTrigger(listener, currentPrice, pctChange);
  callAgent(listener, currentPrice, pctChange);
}
