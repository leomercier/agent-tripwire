# agent-tripwire

Crypto market event system for AI agents. Set price conditions on any asset — when they trip, your agent acts.

Built as infrastructure for [Openclaw](https://openclaw.ai) and other AI agents that need to react to market conditions without polling or manual monitoring.

```bash
# Fire a shell command when BTC crosses $80k
atw event --asset BTC/USD --cross 80000 --trigger "./scripts/notify.sh"

# Forward to your agent if ETH drops 5% in the last hour
atw event --asset ETH/USD --down 5% --time 1h \
  --agent "ETH dropped 5% in the last hour. Assess impact on our position."

# Download historical data for backtesting
atw history --asset BTC/USD --from 2025-01-01 --to 2025-04-01 --interval 1h
```

Powered by [Pyth Network](https://pyth.network) — one shared SSE stream for all listeners, no polling, no rate limits.

---

## Quick start with npx

No install needed for one-off use:

```bash
# Check a live price
npx @astridarena/agent-tripwire price --asset BTC/USD

# Download historical data
npx @astridarena/agent-tripwire history --asset BTC/USD --from 2025-01-01 --to 2025-04-01 --interval 1h

# Set a price alert (starts background daemon automatically)
npx @astridarena/agent-tripwire event --asset BTC/USD --cross 80000 --trigger "echo BTC hit 80k"

# Fire when BTC moves up 0.001%
npx @astridarena/agent-tripwire event --asset BTC/USD --up 0.001% --trigger "echo BTC up 0.001%"
```

Running `event` starts the daemon and prints a confirmation:

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

## Install

**CLI only (npm)**

```bash
npm install -g @astridarena/agent-tripwire
```

Puts `atw` and `agent-tripwire` on your PATH. Requires Node.js 18+.

**CLI + Openclaw skill (clone)**

```bash
git clone https://github.com/leomercier/agent-tripwire
cd agent-tripwire
./install.sh
```

**Openclaw skill only**

```bash
openclaw skills install https://raw.githubusercontent.com/leomercier/agent-tripwire/refs/heads/main/SKILL.md
```

Installs the skill directly into Openclaw without cloning the repo. Useful if you already have `atw` on your PATH.

---

## Commands

### `atw event`

Register a price condition. A background daemon starts automatically and owns the Pyth stream.

```bash
atw event --asset <symbol> [--cross | --up | --down] [--time] [--trigger | --agent] [--once | --repeat]
```

**Conditions**

| Flag              | Description                                                   |
| ----------------- | ------------------------------------------------------------- |
| `--cross <price>` | Fires when price crosses an absolute level (either direction) |
| `--up <N%>`       | Fires when price rises ≥N% from snapshot                      |
| `--down <N%>`     | Fires when price falls ≥N% from snapshot                      |

**Time window** (`--up` / `--down` only)

```bash
--time 1m | 1h | 1d
```

Snapshot resets at the start of each window. Without `--time`, snapshot is fixed at registration.

**Actions** (at least one required)

| Flag               | Description                                        |
| ------------------ | -------------------------------------------------- |
| `--trigger <cmd>`  | Shell command executed on fire                     |
| `--agent <prompt>` | Forwards prompt + market context to Openclaw agent |

**Lifecycle**

| Flag       | Default                                   |
| ---------- | ----------------------------------------- |
| `--once`   | Default for `--cross`                     |
| `--repeat` | Default for `--up`/`--down` with `--time` |

**Examples**

```bash
# BTC crosses $80k — notify once
atw event --asset BTC/USD --cross 80000 \
  --trigger "notify-send 'BTC crossed 80k'"

# BTC crosses $80k — notify once
atw event --asset BTC/USD --cross 80000 \
  --trigger "echo'BTC crossed 80k'"

# ETH down 10% in the last hour — keep watching, call agent
atw event --asset ETH/USD --down 10% --time 1h --repeat \
  --agent "ETH dropped 10% in the last hour. Review our exposure."

# SOL up 5% today — agent suggests action
atw event --asset SOL/USD --up 5% --time 1d \
  --agent "SOL is up 5% today. Suggest position adjustments."

# Both trigger and agent
atw event --asset BTC/USD --down 15% --time 1d \
  --trigger "./scripts/hedge.sh" \
  --agent "BTC down 15% today. Assess impact and recommend hedges."
```

---

### `atw price`

Get the current price for an asset (via stream cache or REST fallback).

```bash
atw price --asset BTC/USD
# BTC/USD: $71,800 (stream)
```

---

### `atw history`

Download historical OHLCV bars to CSV for backtesting or analysis.

```bash
atw history --asset <symbol> --from <date> --to <date> [--interval <interval>] [--output <path>]
```

| Flag         | Description                                                          |
| ------------ | -------------------------------------------------------------------- |
| `--asset`    | Asset symbol, e.g. `BTC/USD`                                         |
| `--from`     | Start date (`YYYY-MM-DD` or Unix seconds)                            |
| `--to`       | End date (`YYYY-MM-DD` or Unix seconds)                              |
| `--interval` | Bar size: `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d` (default: `1h`) |
| `--output`   | Output path (default: `./data/{asset}-{from}-{to}.csv`)              |

```bash
atw history --asset BTC/USD --from 2025-01-01 --to 2025-04-01 --interval 1h
# Downloading BTC/USD 1h bars from 2025-01-01 to 2025-04-01...
# [██████████████████████████████] 100% | chunk 30/30
# Saved 2160 bars to ./data/BTC-USD-2025-01-01-2025-04-01.csv

atw history --asset ETH/USD --from 2024-01-01 --to 2025-01-01 --interval 1d
# → ./data/ETH-USD-2024-01-01-2025-01-01.csv
```

**Output format** (`./data/BTC-USD-2025-04-07-2025-04-09.csv`):

```
timestamp,datetime,open,high,low,close,volume
1743984000000,2025-04-07T00:00:00.000Z,78365.55057166,78455.33439503,77366.68268581,78267.62139362,0
1743987600000,2025-04-07T01:00:00.000Z,78270.20134488,79290.66220108,78260.74,79098.10508419,0
1743991200000,2025-04-07T02:00:00.000Z,79092.14258909,79173.40838859,78344.63898993,78396.31049731,0
1743994800000,2025-04-07T03:00:00.000Z,78397.23521312,78458.58292085,77311.6434523,77665.60999999,0
1743998400000,2025-04-07T04:00:00.000Z,77665.25,77922.7976885,76616.97757302,76933.10911444,0
...
```

- `timestamp` — Unix ms (ready for pandas `pd.to_datetime(df['timestamp'], unit='ms')`)
- `datetime` — ISO 8601 UTC
- `open/high/low/close` — USD price from Pyth Network
- `volume` — always `0` (Pyth TradingView shim does not expose volume)

Data is saved to `./data/` (git-ignored) for local backtesting and analysis.

---

### `atw list`

Show all active listeners.

```bash
atw list

# 2 active listener(s):
#
#   3f2a1b4c-...
#     BTC/USD cross $80000
#     snapshot: $79,500  last: $79,800
#     trigger: notify-send 'BTC crossed 80k'
#
#   9d8e7c6b-...
#     ETH/USD down 10% / 3600000ms window
#     snapshot: $1,800  last: $1,764
#     agent: ETH dropped 10%, review exposure
```

---

### `atw kill`

Remove a listener by ID or asset.

```bash
atw kill 3f2a1b4c-...       # by ID
atw kill --asset BTC/USD    # all listeners for this asset
```

Daemon shuts down when the last listener is removed.

---

## Trigger env vars

Injected into every `--trigger` shell command:

| Var              | Value                    |
| ---------------- | ------------------------ |
| `TW_ASSET`       | e.g. `BTC/USD`           |
| `TW_PRICE`       | Price at fire time       |
| `TW_CONDITION`   | `cross`, `up`, or `down` |
| `TW_PCT_CHANGE`  | % change (up/down only)  |
| `TW_LISTENER_ID` | UUID of the listener     |
| `TW_FIRED_AT`    | ISO 8601 timestamp       |

```bash
#!/bin/bash
# Example trigger script
echo "$TW_ASSET hit $TW_CONDITION at \$$TW_PRICE on $TW_FIRED_AT" >> ~/alerts.log
```

---

## Openclaw integration

Tripwire uses a **dual delivery model** — alerts are queued for heartbeat (primary) and optionally sent via `openclaw agent` as a best-effort fallback.

**Primary — queue for heartbeat:**

Every fired condition writes a JSONL record to `~/.tripwire/alerts.queue`. A heartbeat agent polls this file, surfaces unacknowledged alerts in the main session, and records their ids in `~/.tripwire/alerts.ack` to prevent repeats.

**Fallback — immediate delivery via openclaw agent:**

When `--agent` is set, the daemon sends a self-contained alert to Openclaw using explicit session or agent targeting:

```bash
# targets the session id if TW_SESSION_ID is set
openclaw agent --session-id "$TW_SESSION_ID" --message "TRIPWIRE ALERT ..." --deliver --local

# otherwise falls back to the main agent
openclaw agent --agent main --message "TRIPWIRE ALERT ..." --deliver --local
```

Set a session target for immediate fallback delivery:

```bash
export TW_SESSION_ID=<your-session-id>       # optional: explicit session routing
export TW_OPENCLAW_BIN=/usr/local/bin/openclaw  # optional: default is "openclaw"
```

Skills for agent-tripwire can be added to `~/.openclaw/workspace/skills/`.

---

## Supported assets

BTC, ETH, SOL, AVAX, BNB, ADA, DOT, DOGE, XRP, MATIC, LINK, UNI, NEAR, AAVE, ATOM, LTC, FIL, BCH, TAO, HYPE

Use `COIN/USD` format: `BTC/USD`, `ETH/USD`, etc.

---

## Architecture

```
atw event   ─┐
atw list    ─┤─→ Unix socket (~/.tripwire/tw.sock) ─→ daemon
atw kill    ─┘                                          │
atw history ──────────────────────────────────────────→ Pyth REST (chunked)
                                                       │
                                               Pyth SSE stream (one global connection)
                                                       │
                                               Condition evaluator (every tick)
                                                       │
                                    ┌──────────────────┼──────────────────┐
                                --trigger         enqueue alert        --agent (fallback)
                             shell command    ~/.tripwire/alerts.queue  openclaw agent
                                                       │                 (explicit target)
                                               heartbeat polls queue
                                               surfaces alerts in
                                               main session
```

- **One Pyth stream** serves all assets — no per-asset connections, no polling
- **Daemon auto-start** — spawned detached on first `atw event`, self-terminates when empty
- **CLI is stateless** — connects to socket, gets response, exits
- **Queue-based delivery** — alerts persist in `~/.tripwire/alerts.queue`; heartbeat surfaces them
- **`./data/`** — local CSV store for backtesting (git-ignored)

---

## License

MIT
