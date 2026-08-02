/**
 * Chamber Discord gateway (discord.js) — thin transport, gates intact.
 *
 * Env:
 *   DISCORD_BOT_TOKEN (required)
 *   DISCORD_CLIENT_ID, DISCORD_GUILD_ID
 *   CHAMBER_DISCORD_APPROVERS | CHAMBER_SLACK_APPROVERS  (approve fail-closed)
 *   CHAMBER_DISCORD_ALLOWED_USERS | DISCORD_ALLOWED_USERS  (talk restrict; empty=open)
 *   CHAMBER_DISCORD_FREE_CHANNELS   (comma channel ids — no @mention required)
 *   CHAMBER_DISCORD_OPS_CHANNEL
 *   CHAMBER_DISCORD_REACTION_APPROVE=1  (✅/❌ on ops messages)
 *
 * npm i discord.js
 */

import {
  openDiscordDb,
  gatedDiscordTurn,
  handleDiscordSlash,
  discordApprove,
  discordReject,
  registerDiscordPendingHook,
  canDiscordApprove,
  canDiscordTalk,
  isDiscordFreeResponseChannel,
  sanitizeDiscordOutbound,
  formatAttachmentMeta,
  chunkDiscordMessage,
} from "./discord_ops.ts";

async function main(): Promise<void> {
  if (!process.env.DISCORD_BOT_TOKEN) {
    console.error("Set DISCORD_BOT_TOKEN. See deploy/DISCORD.md");
    process.exit(1);
  }

  let discord: typeof import("discord.js");
  try {
    discord = await import("discord.js");
  } catch {
    console.error(
      "Missing dependency: npm install discord.js\nThen: npm run gateway:discord",
    );
    process.exit(1);
  }

  const {
    Client,
    GatewayIntentBits,
    Partials,
    Events,
    REST,
    Routes,
    SlashCommandBuilder,
    MessageFlags,
    ActivityType,
  } = discord;

  const db = openDiscordDb();
  registerDiscordPendingHook();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  });

  // Slash registration
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (clientId) {
    const rest = new REST().setToken(process.env.DISCORD_BOT_TOKEN!);
    const cmd = new SlashCommandBuilder()
      .setName("chamber")
      .setDescription("Chamber ops + ask")
      .addStringOption((o) =>
        o
          .setName("command")
          .setDescription(
            "status | queue | approve <id> | reject <id> | ask <text> | scope | jobs",
          )
          .setRequired(true),
      );
    try {
      const guildId = process.env.DISCORD_GUILD_ID;
      if (guildId) {
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
          body: [cmd.toJSON()],
        });
        console.log(`Registered guild /chamber on ${guildId}`);
      } else {
        await rest.put(Routes.applicationCommands(clientId), {
          body: [cmd.toJSON()],
        });
        console.log("Registered global /chamber (may take time to appear)");
      }
    } catch (e) {
      console.warn("Slash registration failed:", String(e).slice(0, 200));
    }
  }

  client.once(Events.ClientReady, async (c) => {
    console.log(
      `Chamber Discord up as ${c.user.tag} | approvers=${!!(process.env.CHAMBER_DISCORD_APPROVERS || process.env.CHAMBER_SLACK_APPROVERS)} freeChannels=${(process.env.CHAMBER_DISCORD_FREE_CHANNELS ?? "").length > 0}`,
    );
    try {
      c.user.setPresence({
        activities: [{ name: "Chamber (gated)", type: ActivityType.Watching }],
        status: "online",
      });
    } catch {
      /* optional */
    }
  });

  client.on(Events.Error, (err) => {
    console.error("[discord] client error:", String(err).slice(0, 300));
  });
  client.on(Events.ShardReconnect, () => {
    console.log("[discord] shard reconnecting…");
  });
  client.on(Events.ShardResume, () => {
    console.log("[discord] shard resumed");
  });

  async function replyChunks(
    message: {
      reply: (opts: { content: string; allowedMentions?: object }) => Promise<unknown>;
      channel: { send: (opts: { content: string; allowedMentions?: object }) => Promise<unknown> };
    },
    text: string,
  ): Promise<void> {
    const chunks = chunkDiscordMessage(text);
    const allowedMentions = { parse: [] as string[] }; // no @everyone/@here/@roles
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        await message.reply({ content: chunks[i], allowedMentions });
      } else {
        await message.channel.send({ content: chunks[i], allowedMentions });
      }
    }
  }

  // Mentions, free-response channels, DMs → gated turn
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (message.webhookId) return;
    if (message.system) return;

    const isDm = !message.guild;
    const free = isDiscordFreeResponseChannel(message.channel.id);
    const mentioned =
      client.user != null && message.mentions.has(client.user);

    if (!isDm && !mentioned && !free) return;

    if (!canDiscordTalk(message.author.id)) {
      if (mentioned || isDm) {
        await message
          .reply({
            content: "You are not on `CHAMBER_DISCORD_ALLOWED_USERS`.",
            allowedMentions: { parse: [] },
          })
          .catch(() => {});
      }
      return;
    }

    let text = message.content ?? "";
    if (client.user) {
      text = text.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
    }

    const attMeta = formatAttachmentMeta(
      [...message.attachments.values()].map((a) => ({
        name: a.name,
        contentType: a.contentType,
        size: a.size,
        url: a.url,
      })),
    );
    text = (text + attMeta).trim();
    if (!text) return;

    // Thread-aware channel id for scope
    const channelId = message.channel.id;

    try {
      if ("sendTyping" in message.channel) {
        await (message.channel as { sendTyping: () => Promise<void> }).sendTyping();
      }
      const reply = gatedDiscordTurn(db, text, {
        channelId,
        userId: message.author.id,
        isDm,
      });
      await replyChunks(message, reply);
    } catch (e) {
      await message
        .reply({
          content: sanitizeDiscordOutbound(`Chamber error: ${String(e).slice(0, 200)}`),
          allowedMentions: { parse: [] },
        })
        .catch(() => {});
    }
  });

  // Slash + buttons
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand() && interaction.commandName === "chamber") {
      if (!canDiscordTalk(interaction.user.id)) {
        await interaction.reply({
          content: "You are not on `CHAMBER_DISCORD_ALLOWED_USERS`.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const raw = interaction.options.getString("command") ?? "help";
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const result = handleDiscordSlash(db, raw, {
          userId: interaction.user.id,
          channelId: interaction.channelId ?? "unknown",
          isDm: !interaction.guild,
        });
        await interaction.editReply({
          content: sanitizeDiscordOutbound(result.ephemeral),
        });
        if (
          result.publicReply &&
          interaction.channel &&
          "send" in interaction.channel
        ) {
          for (const chunk of chunkDiscordMessage(result.publicReply)) {
            await interaction.channel.send({
              content: chunk,
              allowedMentions: { parse: [] },
            });
          }
        }
      } catch (e) {
        await interaction.editReply(
          sanitizeDiscordOutbound(`error: ${String(e).slice(0, 200)}`),
        );
      }
      return;
    }

    if (interaction.isButton()) {
      const id = interaction.customId;
      const userId = interaction.user.id;
      if (id.startsWith("chamber_approve:")) {
        const writeId = id.slice("chamber_approve:".length);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const r = discordApprove(db, writeId, userId);
        await interaction.editReply(sanitizeDiscordOutbound(r.text));
        if (r.ok && interaction.message) {
          await interaction.message
            .edit({
              content: sanitizeDiscordOutbound(`✅ ${r.text} by <@${userId}>`),
              components: [],
            })
            .catch(() => {});
        }
        return;
      }
      if (id.startsWith("chamber_reject:")) {
        const writeId = id.slice("chamber_reject:".length);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const r = discordReject(db, writeId, userId);
        await interaction.editReply(sanitizeDiscordOutbound(r.text));
        if (r.ok && interaction.message) {
          await interaction.message
            .edit({
              content: sanitizeDiscordOutbound(`❌ ${r.text} by <@${userId}>`),
              components: [],
            })
            .catch(() => {});
        }
        return;
      }
    }
  });

  // Optional: ✅ / ❌ reactions on messages that contain pw_ ids (ops convenience)
  if (process.env.CHAMBER_DISCORD_REACTION_APPROVE === "1") {
    client.on(Events.MessageReactionAdd, async (reaction, user) => {
      if (user.bot) return;
      try {
        if (reaction.partial) await reaction.fetch();
        if (reaction.message.partial) await reaction.message.fetch();
      } catch {
        return;
      }
      const emoji = reaction.emoji.name;
      if (emoji !== "✅" && emoji !== "❌") return;
      if (!canDiscordApprove(user.id)) return;
      const content = reaction.message.content ?? "";
      const m = content.match(/\b(pw_[a-f0-9]+)\b/i);
      if (!m) return;
      const writeId = m[1];
      const r =
        emoji === "✅"
          ? discordApprove(db, writeId, user.id)
          : discordReject(db, writeId, user.id);
      const ch = reaction.message.channel;
      if (ch && "send" in ch) {
        await ch
          .send({
            content: sanitizeDiscordOutbound(`${r.text} (via reaction)`),
            allowedMentions: { parse: [] },
          })
          .catch(() => {});
      }
    });
  }

  await client.login(process.env.DISCORD_BOT_TOKEN);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
