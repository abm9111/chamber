# Chamber production TLS reverse proxy

Chamber’s HTTP server binds **localhost only** (`127.0.0.1:8787`).  
TLS, public DNS, and auth belong on a reverse proxy — not inside the Node process.

```
Internet ──TLS──▶ Reverse proxy ──http──▶ 127.0.0.1:8787 (Chamber)
                     ▲
                     └── certs, rate limits, auth, logs
```

## Options ranked for Chamber

| Proxy | Best when | TLS | Notes |
|-------|-----------|-----|--------|
| **Caddy** | Solo / small VPS | Automatic Let’s Encrypt | Least config; see `Caddyfile` |
| **nginx + certbot** | Existing nginx fleet | certbot | Battle-tested; see `nginx-chamber.conf` |
| **Traefik** | Docker / multi-service | ACME built-in | See `traefik-dynamic.yml` |
| **Cloudflare Tunnel** | No open inbound ports | Cloudflare edge | Good for home lab / zero public bind |

## Non-negotiables

1. **Chamber stays on loopback** — never `0.0.0.0` in production without a proxy + auth.
2. **HTTPS only** for public clients (HSTS once stable).
3. **Auth in front** — basic auth, mTLS, or SSO; Chamber has no user model yet.
4. **Rate limit** `/turn` and `/deliberate` (LLM spend + abuse).
5. **Body size cap** (~1 MB); Chamber is JSON API, not file upload.
6. **Forward `X-Forwarded-*`** if you later log client IP in audit (today optional).

## Quick paths

### Caddy (simplest)

```bash
# Chamber
CHAMBER_DB=/var/lib/chamber/chamber.sqlite PORT=8787 npm run server

# Proxy (edit host in deploy/Caddyfile first)
caddy run --config deploy/Caddyfile
```

### nginx + Let’s Encrypt

```bash
sudo cp deploy/nginx-chamber.conf /etc/nginx/sites-available/chamber
# edit server_name
sudo ln -sf /etc/nginx/sites-available/chamber /etc/nginx/sites-enabled/
sudo certbot --nginx -d chamber.example.com
sudo nginx -t && sudo systemctl reload nginx
```

### Cloudflare Tunnel (no public port)

```bash
cloudflared tunnel create chamber
cloudflared tunnel route dns chamber chamber.example.com
# config.yml:
#   ingress:
#     - hostname: chamber.example.com
#       service: http://127.0.0.1:8787
#     - service: http_status:404
cloudflared tunnel run chamber
```

TLS terminates at Cloudflare; origin stays HTTP on localhost.

## Security extras (recommended)

| Control | How |
|---------|-----|
| Basic auth | nginx `auth_basic` / Caddy `basicauth` / Traefik middleware |
| mTLS | nginx `ssl_verify_client on` for operator-only API |
| IP allowlist | `allow 10.0.0.0/8; deny all;` on admin routes |
| Separate DB volume | `CHAMBER_DB` on encrypted disk |
| Process user | run Node as unprivileged `chamber` user |
| Fail2ban | ban on 401/429 bursts from proxy logs |

## What Chamber should *not* do

- Terminate TLS in-process (cert rotation, cipher suites, ACME = proxy job)
- Bind `0.0.0.0` without auth
- Trust raw `X-Forwarded-For` without a trusted proxy hop

## Health checks

Proxy should probe `GET /health` → `{"ok":true,"service":"chamber"}`.

Do **not** expose `/checkpoint` publicly without auth (audit root is sensitive metadata).

## Next hardening (if you say go)

1. Shared secret header (`CHAMBER_API_TOKEN`) checked in `server.ts`
2. systemd unit + Caddy service pair
3. Docker Compose: `chamber` + `caddy` only on internal network

## Auth header (shipped)

Set `CHAMBER_API_TOKEN`. Clients send `Authorization: Bearer <token>` or `X-Chamber-Token: <token>`. `GET /health` remains open for probes.

Compose: `deploy/docker-compose.yml` · systemd: `deploy/systemd/`
