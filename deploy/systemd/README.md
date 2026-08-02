# Chamber systemd units

| Unit | Role |
|------|------|
| **chamber.service** | HTTP kernel (`server.ts` :8787) |
| **chamber-slack.service** | Slack Socket Mode (`slack_runner.ts`) |
| **chamber-discord.service** | Discord gateway (`discord_runner.ts`) |
| **chamber-jobs.service** | One-shot `jobs run` |
| **chamber-jobs.timer** | Every 5 minutes → jobs.service |
| **caddy-chamber.service** | TLS reverse proxy |
| **chamber.socket** | Optional socket activation on 127.0.0.1:8787 |
| **chamber.target** | Groups core stack |

## Install

```bash
sudo useradd -r -s /usr/sbin/nologin chamber || true
sudo mkdir -p /opt/chamber /var/lib/chamber /etc/chamber
sudo cp -a /path/to/chamber/. /opt/chamber/
sudo cp deploy/systemd/env.example /etc/chamber/env
sudo chmod 600 /etc/chamber/env
# edit /etc/chamber/env — tokens, posture, Slack

sudo cp deploy/systemd/*.service deploy/systemd/*.timer deploy/systemd/*.target \
  /etc/systemd/system/
sudo systemctl daemon-reload

sudo systemctl enable --now chamber.service
sudo systemctl enable --now chamber-jobs.timer
# optional:
# sudo systemctl enable --now chamber-slack.service
# sudo systemctl enable --now caddy-chamber.service
# sudo systemctl enable --now chamber.target
```

## Env file

`/etc/chamber/env` (see `env.example`):

```bash
CHAMBER_API_TOKEN=...
CHAMBER_TOKEN_KEY=...
CHAMBER_POSTURE=auto
CHAMBER_PILOT=1
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
CHAMBER_SLACK_APPROVERS=U...
CHAMBER_SLACK_OPS_CHANNEL=C...
```

## Status

```bash
systemctl status chamber.service chamber-slack.service chamber-jobs.timer
journalctl -u chamber.service -f
```


## Socket activation (optional)

Use when you want systemd to hold `127.0.0.1:8787` and start Chamber on first connection (or keep the socket up across service restarts).

```bash
# Prefer socket unit; avoid double-bind on the same port
sudo systemctl disable --now chamber.service   # if already running with own bind
sudo systemctl enable --now chamber.socket
# First HTTP request (or: systemctl start chamber.service) starts the kernel
curl -sS http://127.0.0.1:8787/health
```

`server.ts` detects `LISTEN_FDS` + `LISTEN_PID` and calls `server.listen({ fd: 3 })`.
If those env vars are absent, it falls back to `PORT` + `CHAMBER_BIND`.

**Do not** run Caddy → 8787 **and** leave Chamber binding 8787 itself while also using the socket unit on the same address — pick one owner for the port.

With **Caddy on :443** proxying to 8787, socket activation is optional; always-on `chamber.service` is simpler for pilots.
