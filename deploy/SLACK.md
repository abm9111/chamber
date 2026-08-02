# Chamber Slack pipeline

## Requirements

```bash
npm install @slack/bolt
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...      # Socket Mode, connections:write
export CHAMBER_DB=/var/lib/chamber/chamber.sqlite
export CHAMBER_SLACK_APPROVERS=U0123ABCD,U0456EFGH   # fail-closed if empty
# optional:
export CHAMBER_SLACK_OPS_CHANNEL=C0OPS...
export CHAMBER_POSTURE=auto   # or strict
```

## Slack app checklist

1. Socket Mode **ON** + app-level token `connections:write`
2. Bot scopes: `app_mentions:read`, `chat:write`, `commands`, `im:history` (optional)
3. Events: `app_mention`, `message.im`
4. Slash command: `/chamber`
5. Interactivity **ON** (Socket Mode — no Request URL)
6. Install to workspace

## Run

```bash
# terminal 1 (optional if using in-process DB only)
npm run serve

# terminal 2
npm run gateway:slack
```

## Usage

| Action | How |
|--------|-----|
| Ask | `@Chamber …` in channel (thread reply) or DM |
| Status / queue | `/chamber status` · `/chamber queue` |
| Approve | `/chamber approve pw_…` or **Approve** button |
| Reject | `/chamber reject pw_…` |
| Ask via slash | `/chamber ask …` |

All turns and approves go through Chamber gates. Empty `CHAMBER_SLACK_APPROVERS` → approve always denied.
