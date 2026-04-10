---
name: agent-tripwire
description: >
  Use this skill to set price alerts and event triggers on crypto assets using the `agent-tripwire` CLI (alias: `atw`).
  Triggers when the user wants to watch a price, be notified when something crosses a level,
  react to percentage moves over a time window, or connect a price event to an agent action.
  Examples: "alert me when BTC hits 75k", "watch ETH for a 10% drop today",
  "run a script if SOL pumps 5% in an hour", "what's the current BTC price",
  "install tripwire", "set up a price alert".
metadata:
  openclaw:
    requires:
      bins: [agent-tripwire, atw]
---

# agent-tripwire

agent-tripwire watches crypto asset prices via Pyth Network and fires actions when conditions are met.
The `agent-tripwire` CLI (alias: `atw`) manages a background daemon — one shared price stream, multiple listeners.

## Installation

### Option 1: npx (no install, one-off use)

```bash
# Check a live price
npx @astridarena/agent-tripwire price --asset BTC/USD

# Download historical data
npx @astridarena/agent-tripwire history --asset BTC/USD --from 2025-01-01 --to 2025-04-01 --interval 1h

# Set a price alert (starts background daemon automatically)
npx @astridarena/agent-tripwire event --asset BTC/USD --cross 80000 --trigger "echo BTC hit 80k"
```

### Option 2: Global npm install (recommended for regular use)

```bash
npm install -g @astridarena/agent-tripwire
# Puts `agent-tripwire` and `atw` on your PATH
# Requires Node.js 18+
```

### Option 3: Clone and install (also installs the Openclaw skill)

```bash
git clone https://github.com/leomercier/agent-tripwire
cd agent-tripwire
./install.sh
```

### Option 4: Install skill directly via Openclaw

```bash
openclaw skills install https://raw.githubusercontent.com/leomercier/agent-tripwire/refs/heads/main/SKILL.md
```

Installs the skill into Openclaw without cloning the repo. Use this if you already have `atw` on your PATH.

After install, confirm it's working:

```bash
atw price --asset BTC/USD
# BTC/USD: $71,800 (stream)
```

---

## Core commands

```bash
# Current price (instant, no daemon needed)
atw price --asset BTC/USD

# Price crosses an absolute level — fires once, then removes itself
atw event --asset BTC/USD --cross 72000 --trigger "notify-send 'BTC 72k'"

# Percentage move within a rolling window — fires and re-arms each window
atw event --asset ETH/USD --down 10% --time 1h --trigger "./alert.sh"

# Forward to an agent on condition
atw event --asset SOL/USD --up 5% --time 1d \
  --agent "SOL up 5% today. Summarise implications for our position."

# Both trigger and agent (trigger fires first)
atw event --asset BTC/USD --down 15% --time 1d \
  --trigger "./hedge.sh" \
  --agent "BTC dropped 15% today. Assess impact."

# Small percentage move alert
atw event --asset BTC/USD --up 0.001% --trigger "echo BTC up 0.001%"

# TAO-specific example (Bittensor)
atw event --asset TAO/USD --cross 500 \
  --agent "TAO crossed $500. Assess validator and staking implications."

# Inspect and manage
atw list
atw kill <listener-id>
atw kill --asset BTC/USD
```

### Daemon confirmation output

When an event is registered the daemon confirms:

```
Starting agent-tripwire daemon...
✓ Listener registered
  ID:        4e73cf5d-25a9-422a-a99e-01200c270d59
  Asset:     BTC/USD
  Condition: cross 80000
  Snapshot:  $71,801.25
  Once:      true
  Trigger:   echo BTC hit 80k
```

---

## Historical data download

```bash
# Download hourly BTC bars to CSV for backtesting
atw history --asset BTC/USD --from 2025-01-01 --to 2025-04-01 --interval 1h

# Daily ETH bars for a full year
atw history --asset ETH/USD --from 2024-01-01 --to 2025-01-01 --interval 1d
```

Output format (`./data/BTC-USD-2025-01-01-2025-04-01.csv`):

```
timestamp,datetime,open,high,low,close,volume
1743984000000,2025-04-07T00:00:00.000Z,78365.55,78455.33,77366.68,78267.62,0
...
```

- `timestamp` — Unix ms (pandas: `pd.to_datetime(df['timestamp'], unit='ms')`)
- `datetime` — ISO 8601 UTC
- `open/high/low/close` — USD price from Pyth Network
- `volume` — always `0` (Pyth does not expose volume)

Saved to `./data/` (git-ignored) for local backtesting.

---

## Flag reference

| Flag               | Description                                                             |
| ------------------ | ----------------------------------------------------------------------- |
| `--asset`          | Coin pair: `BTC/USD`, `ETH/USD`, `SOL/USD`, `TAO/USD`, `HYPE/USD`, etc. |
| `--cross <price>`  | Fires when price crosses this absolute value in either direction        |
| `--up <N%>`        | Fires when price rises ≥N% from snapshot                                |
| `--down <N%>`      | Fires when price falls ≥N% from snapshot                                |
| `--time <window>`  | Rolling window: `1m`, `1h`, `1d`. Resets snapshot each period           |
| `--trigger <cmd>`  | Shell command to run on fire                                            |
| `--agent <prompt>` | Sends prompt to openclaw: `openclaw agent --message "<ctx>\n<prompt>"`  |
| `--once`           | Remove listener after first fire (default for `--cross`)                |
| `--repeat`         | Re-arm after firing (default for `--up`/`--down` with `--time`)         |

---

## Trigger env vars

Available inside every `--trigger` shell command:

```
TW_ASSET, TW_PRICE, TW_CONDITION, TW_PCT_CHANGE, TW_LISTENER_ID, TW_FIRED_AT
```

Example trigger script:

```bash
#!/bin/bash
echo "$TW_ASSET hit $TW_CONDITION at \$$TW_PRICE on $TW_FIRED_AT" >> ~/alerts.log
```

---

## Alert delivery model

Tripwire uses a dual delivery model. Do not assume the daemon can callback directly into the open webchat turn.

**Primary delivery — queue for heartbeat:**
1. Every trigger writes a JSONL record to `~/.tripwire/alerts.queue`
2. Heartbeat polls the queue and surfaces new alerts in the main session
3. Acknowledged alert ids are recorded in `~/.tripwire/alerts.ack` to prevent duplicates

**Fallback delivery — best-effort via openclaw agent:**
1. If `TW_SESSION_ID` is set, the daemon calls `openclaw agent --session-id "$TW_SESSION_ID"`
2. Otherwise it targets `--agent main`
3. The message is self-contained so it can be surfaced without additional context
4. Never rely on `--deliver --local` alone without an explicit session or agent target

Configure the Openclaw binary path if non-default:

```bash
export TW_OPENCLAW_BIN=/usr/local/bin/openclaw  # default: "openclaw"
```

Set a session target for immediate fallback delivery:

```bash
export TW_SESSION_ID=<your-session-id>
```

---

## Heartbeat rules

- During heartbeat, read `HEARTBEAT.md` and check for unacknowledged queued alerts
- If there are no new alerts, reply exactly `HEARTBEAT_OK`
- If there are new alerts, return only the alert summary — do not include `HEARTBEAT_OK`
- Deduplicate by alert `id`
- Batch alerts that fire close together

Recommended heartbeat config:

```json
{
  "agents": {
    "defaults": {
      "heartbeat": {
        "every": "5m",
        "target": "last",
        "lightContext": true,
        "prompt": "Read HEARTBEAT.md if it exists. Follow it strictly. If nothing needs attention, reply HEARTBEAT_OK."
      }
    }
  }
}
```

---

## How to help the user

- If the user asks to install tripwire, recommend `npm install -g @astridarena/agent-tripwire` for regular use, or `npx @astridarena/agent-tripwire` for one-off use
- When the user describes a price condition in natural language, translate it to the correct `atw event` command
- Prefer `--agent` over `--trigger` when the user wants analysis or a follow-up action from the agent
- Combine both flags when the intent is "run a script AND get a summary"
- For one-off alerts use `--once`; for ongoing monitoring use `--repeat` with `--time`
- If the user asks about active listeners, run `atw list`
- If the user wants to cancel a watch, run `atw kill`
- Always use `atw` (or `agent-tripwire`) — never the old `tw` alias

---

## Supported assets

BTC, ETH, SOL, AVAX, BNB, ADA, DOT, DOGE, XRP, MATIC, LINK, UNI, NEAR, AAVE, ATOM, LTC, FIL, BCH, TAO, HYPE

Use `COIN/USD` format: `BTC/USD`, `ETH/USD`, `TAO/USD`, etc.

---

## Daemon notes

The daemon starts automatically on first `atw event` and self-terminates when all listeners are removed.
State lives at `~/.tripwire/`. Logs at `~/.tripwire/logs/daemon.log`.
Skills for agent-tripwire can be added to `~/.openclaw/workspace/skills/`.
