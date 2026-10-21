# Chamber Slack pipeline

## Requirements

```bash
npm install @slack/bolt
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...      # Socket Mode, connections:write
export CHAMBER_DB=/var/lib/chamber/chamber.sqlite
export CHAMBER_SLACK_APPROVERS=U0123ABCD,U0456EFGH   # fail-closed if empty
export CHAMBER_SLACK_ALLOWED_USERS=U0123ABCD,U0456EFGH  # who may talk to the bot; empty = nobody
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

**Who may talk.** `CHAMBER_SLACK_ALLOWED_USERS` is a comma list of Slack user ids. It is
fail-closed like the approver list: **empty means nobody**, and the runner logs
`chamber: CHAMBER_SLACK_ALLOWED_USERS is empty, so nobody can talk to this bot` at
startup. A user who is not listed gets `You are not on CHAMBER_SLACK_ALLOWED_USERS.` when
they mention the bot, DM it or run `/chamber`, and no turn is started. Being allowed to
talk does not make anyone an approver. Before this variable existed the Slack runner let
any user in a channel with the bot drive a turn, so an existing deployment answers
nobody until it is set.
