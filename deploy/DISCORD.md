# Chamber Discord pipeline

Same rules as Slack: **Discord transports; Chamber decides.**

## Env

```bash
export DISCORD_BOT_TOKEN=...
export DISCORD_CLIENT_ID=...              # for slash registration
export DISCORD_GUILD_ID=...               # optional: instant guild commands
export CHAMBER_DISCORD_APPROVERS=123,456  # Discord user snowflakes; fail-closed if empty
export CHAMBER_DISCORD_OPS_CHANNEL=...    # channel id for pending cards
export CHAMBER_DB=/var/lib/chamber/chamber.sqlite
```

(`CHAMBER_SLACK_APPROVERS` is used as fallback if Discord list is unset.)

## Bot setup (Discord Developer Portal)

1. Create application → Bot → token  
2. Privileged intents: **Message Content**  
3. OAuth2 URL: scopes `bot`, `applications.commands`  
4. Bot permissions: View Channels, Send Messages, Read Message History, Use Slash Commands  
5. Invite to server  

## Run

```bash
npm install discord.js
npm run gateway:discord
```

## Usage

| Action | How |
|--------|-----|
| Ask | `@Chamber …` or DM |
| Ops | `/chamber` with option: `status`, `queue`, `approve pw_…`, `ask …` |
| Approve | Button on ops card or `/chamber` → `approve <id>` |

## systemd

```bash
sudo cp deploy/systemd/chamber-discord.service /etc/systemd/system/
# add DISCORD_* to /etc/chamber/env
sudo systemctl enable --now chamber-discord.service
```


## Hardening (Hermes-inspired, still thin)

| Env | Effect |
|-----|--------|
| `CHAMBER_DISCORD_ALLOWED_USERS` | Restrict who can talk (empty = open) |
| `CHAMBER_DISCORD_FREE_CHANNELS` | Channel IDs that work without @mention |
| `CHAMBER_DISCORD_REACTION_APPROVE=1` | ✅/❌ on messages containing `pw_…` |
| outbound | `@everyone` / `@here` neutralized; `allowedMentions.parse=[]` |
| attachments | **Metadata only** in the turn text — not downloaded |

Still not Hermes: no voice, no media pipeline, no channel skill bindings.
