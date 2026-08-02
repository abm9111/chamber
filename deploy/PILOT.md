# Chamber pilot runbook (2 weeks, 1–3 operators)

## Day-0 checklist

```bash
# secrets
export CHAMBER_API_TOKEN=$(openssl rand -hex 24)
export CHAMBER_TOKEN_KEY=$(openssl rand -base64 32)   # if MCP OAuth
export CHAMBER_POSTURE=auto                           # or strict for shared channels
export CHAMBER_PILOT=1
export CHAMBER_PILOT_LOG=/var/lib/chamber/pilot.jsonl
export CHAMBER_DB=/var/lib/chamber/chamber.sqlite

# Slack (optional)
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...
export CHAMBER_SLACK_APPROVERS=U0123,U0456
export CHAMBER_SLACK_OPS_CHANNEL=C0OPS...
```

- [ ] SQLite path backed up (`cp chamber.sqlite chamber.sqlite.bak`)
- [ ] Spend budget written down ($/day)
- [ ] Approvals stay **on** — no standing bypass
- [ ] systemd: `chamber.service` + optional `chamber-slack` + `chamber-jobs.timer`

```bash
sudo systemctl enable --now chamber.service
sudo systemctl enable --now chamber-jobs.timer
# sudo systemctl enable --now chamber-slack.service
```

## Daily (5 min)

1. `chamber queue` / `/chamber queue` — oldest pending age
2. `chamber jobs run` if timer not used
3. Glance spend footer
4. One line: “slowest thing today”

## Friction log (per painful task)

```text
[task] …
[wait] ~Xs
[approvals] N
[blocks] code / none
[felt] 1–5
[note] …
```

Or with pilot mode: events land in `pilot_event` + `CHAMBER_PILOT_LOG`.

## Success (2 weeks)

- Zero standing gate bypasses
- Some **correct** blocks (gates working)
- Felt median ≥ 3
- No “skill rewrote itself” incidents

## Kill criteria

- Team only uses it with approvals off
- Queue rot > 48h with no process
- Spend spike without outcomes

## Commands

```bash
npm run serve
npm run gateway:slack
node --experimental-strip-types src/cli.ts queue
node --experimental-strip-types src/cli.ts jobs run
node --experimental-strip-types src/cli.ts status
```

CHAMBER_SPEND_CAP_USD=
CHAMBER_SURFACE_RATE_CAPACITY=8
CHAMBER_SURFACE_RATE_REFILL_MS=60000