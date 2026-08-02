# Launching Chamber

## Day-1 (recommended)

```bash
# 1. Token + DB
export CHAMBER_API_TOKEN=$(openssl rand -hex 24)
export CHAMBER_DB=/var/lib/chamber/chamber.sqlite

# 2. HTTP (loopback)
npm run serve

# 3. TLS edge
caddy run --config deploy/Caddyfile
# or: docker compose -f deploy/docker-compose.yml up

# 4. Optional Telegram daily driver
export TELEGRAM_BOT_TOKEN=...
npm run gateway:telegram
```

## Apple app — recommendation

**Not worth a full iOS App Store launch yet.**

| Path | Worth it? | Why |
|------|-----------|-----|
| **iPhone App Store** | No (now) | Chamber is a kernel + gates; App Store wants consumer UX, background limits fight long-running agents, review risk for “AI agent” tooling |
| **Mac App Store** | Maybe later | Possible as wrapper around local server; sandbox fights local tools/MCP |
| **Mac menu bar / DMG (direct)** | Yes, later | Power-user fit: starts local Chamber + status + approve queue |
| **PWA / Safari to HTTPS API** | Yes, cheap | Use existing `/turn` + token; no App Store |
| **Telegram (now)** | **Best** | Hermes users already live here; zero App Store cost |

**Do this order:** Telegram or HTTPS daily driver → Mac menu bar if power users ask → iOS only if you productize a *narrow* approve/status client, not the full kernel.

Building the full kernel *inside* an iOS app is the wrong boundary: keep Chamber on a machine/VPS, put a thin Apple client in front later if needed.
