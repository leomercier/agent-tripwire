---
name: tripwire
description: >
  Use this skill to set price alerts and event triggers on crypto assets using the `tw` CLI.
  Triggers when the user wants to watch a price, be notified when something crosses a level,
  react to percentage moves over a time window, or connect a price event to an agent action.
  Examples: "alert me when BTC hits 75k", "watch ETH for a 10% drop today",
  "run a script if SOL pumps 5% in an hour", "what's the current BTC price".
metadata:
  openclaw:
    requires:
      bins: [tw]
---

# tripwire

tripwire watches crypto asset prices via Pyth Network and fires actions when conditions are met.
The `tw` CLI manages a background daemon — one shared price stream, multiple listeners.

## Core commands

```bash
# Current price (instant, no daemon needed)
tw price --asset BTC/USD

# Price crosses an absolute level — fires once, then removes itself
tw event --asset BTC/USD --cross 72000 --trigger "notify-send 'BTC 72k'"

# Percentage move within a rolling window — fires and re-arms each window
tw event --asset ETH/USD --down 10% --time 1h --trigger "./alert.sh"

# Forward to an agent on condition
tw event --asset SOL/USD --up 5% --time 1d \
  --agent "SOL up 5% today. Summarise implications for our position."

# Both trigger and agent (trigger fires first)
tw event --asset BTC/USD --down 15% --time 1d \
  --trigger "./hedge.sh" \
  --agent "BTC dropped 15% today. Assess impact."

# Inspect and manage
tw list
tw kill <listener-id>
tw kill --asset BTC/USD
```

## Flag reference

| Flag | Description |
|---|---|
| `--asset` | Coin pair: `BTC/USD`, `ETH/USD`, `SOL/USD`, `TAO/USD`, `HYPE/USD`, etc. |
| `--cross <price>` | Fires when price crosses this absolute value in either direction |
| `--up <N%>` | Fires when price rises ≥N% from snapshot |
| `--down <N%>` | Fires when price falls ≥N% from snapshot |
| `--time <window>` | Rolling window: `1m`, `1h`, `1d`. Resets snapshot each period |
| `--trigger <cmd>` | Shell command to run on fire |
| `--agent <prompt>` | Sends prompt to openclaw: `openclaw agent --message "<ctx>\n<prompt>"` |
| `--once` | Remove listener after first fire (default for `--cross`) |
| `--repeat` | Re-arm after firing (default for `--up`/`--down` with `--time`) |

## Trigger env vars

Available inside every `--trigger` shell command:

```
TW_ASSET, TW_PRICE, TW_CONDITION, TW_PCT_CHANGE, TW_LISTENER_ID, TW_FIRED_AT
```

## Agent call format

When `--agent` fires, tripwire runs:
```bash
openclaw agent --message "TW_ASSET=BTC/USD TW_PRICE=71800 TW_CONDITION=down TW_PCT_CHANGE=5.23% TW_FIRED_AT=...

<user prompt>"
```

## How to help the user

- When the user describes a price condition in natural language, translate it to the correct `tw event` command
- Prefer `--agent` over `--trigger` when the user wants analysis or a follow-up action from the agent
- Combine both flags when the intent is "run a script AND get a summary"
- For one-off alerts use `--once`; for ongoing monitoring use `--repeat` with `--time`
- If the user asks about active listeners, run `tw list`
- If the user wants to cancel a watch, run `tw kill`

## Supported assets

BTC, ETH, SOL, AVAX, BNB, ADA, DOT, DOGE, XRP, MATIC, LINK, UNI, NEAR, AAVE, ATOM, LTC, FIL, BCH, TAO, HYPE

## Daemon notes

The daemon starts automatically on first `tw event` and self-terminates when all listeners are removed.
State lives at `~/.tripwire/`. Logs at `~/.tripwire/logs/daemon.log`.
