# Tripwire heartbeat tasks

1. Check `~/.tripwire/alerts.queue` for new JSONL alerts.
2. Ignore alerts whose `id` already exists in `~/.tripwire/alerts.ack`.
3. If there are new alerts:
   - group related alerts fired close together
   - summarize them clearly for the user
   - after surfacing them, append their ids to `~/.tripwire/alerts.ack`
4. If there is nothing new or actionable, reply exactly `HEARTBEAT_OK`.
5. Do not repeat previously acknowledged alerts unless a new alert event has a new id.
