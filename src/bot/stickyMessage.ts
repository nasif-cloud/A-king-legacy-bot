import fs from 'node:fs';
import path from 'node:path';
import {
  ChannelType,
  ChatInputCommandInteraction,
  Message,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type GuildTextBasedChannel,
} from 'discord.js';
import {
  getLeaderElectionDelayMs,
  isInPassiveStandby,
  isSupersededLocally,
} from './leadership.js';

interface StickyEntry {
  guildId: string;
  channelId: string;
  content: string;
  lastMessageId: string | null;
  allowEveryone: boolean;
  updatedAt: number;
}

const STICKY_STORE_PATH = path.resolve(process.cwd(), '.sticky-messages.json');
const REPOST_DEBOUNCE_MS = 1500;

// In-memory store keyed by channelId supporting unlimited sticky messages across servers
const stickyStore = new Map<string, StickyEntry>();
const repostTimers = new Map<string, NodeJS.Timeout>();
const inFlightChannels = new Set<string>();

// Loads saved sticky messages from disk on startup
export function loadStickyMessages(): void {
  try {
    if (!fs.existsSync(STICKY_STORE_PATH)) return;
    const raw = fs.readFileSync(STICKY_STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as StickyEntry[];
    if (!Array.isArray(parsed)) return;

    stickyStore.clear();
    for (const entry of parsed) {
      if (entry && typeof entry.channelId === 'string' && typeof entry.content === 'string') {
        stickyStore.set(entry.channelId, entry);
      }
    }
  } catch (error) {
    console.warn(
      'Could not load sticky messages store:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

// Saves all active sticky messages to disk so restarts preserve them
function saveStickyMessages(): void {
  try {
    const entries = [...stickyStore.values()];
    fs.writeFileSync(STICKY_STORE_PATH, JSON.stringify(entries, null, 2), 'utf8');
  } catch (error) {
    console.warn(
      'Could not save sticky messages store:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

// Converts escaped "\n" into real newlines while preserving all Discord markdown (#, -#, **, __, emojis, etc.)
function formatStickyContent(rawText: string): string {
  return rawText.replace(/\\n/g, '\n').trim().slice(0, 2000);
}

// Checks whether a channel supports sending sticky messages
function isSupportedStickyChannel(channel: unknown): channel is GuildTextBasedChannel {
  if (!channel || typeof channel !== 'object') return false;
  const ch = channel as { type?: ChannelType; isTextBased?: () => boolean; isDMBased?: () => boolean };
  return Boolean(ch.isTextBased?.() && !ch.isDMBased?.());
}

// Slash command: /stickymessage <message>
export const stickyAddCommandData = new SlashCommandBuilder()
  .setName('stickymessage')
  .setDescription('add a sticky message to a channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addStringOption((option) =>
    option
      .setName('message')
      .setDescription('message text (supports Discord markdown like #, -#, **bold**, and \\n)')
      .setRequired(true)
      .setMaxLength(2000),
  );

// Slash command: /stickmessage remove <channel>
export const stickyRemoveCommandData = new SlashCommandBuilder()
  .setName('stickmessage')
  .setDescription('remove a sticky message from a channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('remove the sticky message from a channel')
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('channel to remove the sticky message from')
          .setRequired(true)
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
            ChannelType.PublicThread,
            ChannelType.PrivateThread,
          ),
      ),
  );

// Safely deletes an old sticky message if it still exists
async function tryDeleteStickyMessage(
  channel: GuildTextBasedChannel,
  messageId: string | null,
): Promise<void> {
  if (!messageId) return;
  try {
    await channel.messages.delete(messageId);
  } catch {
    // Ignore if already deleted or missing permissions
  }
}

// Moves the sticky message to the bottom of the channel without duplicating when multiple instances exist
async function repostStickyInChannel(channel: GuildTextBasedChannel): Promise<void> {
  const entry = stickyStore.get(channel.id);
  if (!entry) return;
  if (isSupersededLocally() || isInPassiveStandby()) return;
  if (inFlightChannels.has(channel.id)) return;

  inFlightChannels.add(channel.id);
  try {
    // Let the newest bot instance win if multiple instances are online
    const leaderDelay = getLeaderElectionDelayMs();
    if (leaderDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, leaderDelay));
    }
    if (isSupersededLocally() || isInPassiveStandby()) return;

    const latestEntry = stickyStore.get(channel.id);
    if (!latestEntry) return;

    const me = channel.guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      return;
    }

    // Check recent messages so we don't repost if another instance already put this sticky message at the bottom
    try {
      const recent = await channel.messages.fetch({ limit: 3 });
      const newest = recent.first();
      if (
        newest &&
        newest.author.id === channel.client.user?.id &&
        newest.content === latestEntry.content
      ) {
        latestEntry.lastMessageId = newest.id;
        saveStickyMessages();
        return;
      }

      // Clean up any prior sticky copy found in the last 3 messages
      for (const msg of recent.values()) {
        if (
          msg.author.id === channel.client.user?.id &&
          (msg.id === latestEntry.lastMessageId || msg.content === latestEntry.content)
        ) {
          await tryDeleteStickyMessage(channel, msg.id);
        }
      }
    } catch {
      await tryDeleteStickyMessage(channel, latestEntry.lastMessageId);
    }

    // Also ensure the tracked lastMessageId is deleted even if > 3 messages buried it
    if (latestEntry.lastMessageId) {
      await tryDeleteStickyMessage(channel, latestEntry.lastMessageId);
    }

    const posted = await channel.send({
      content: latestEntry.content,
      allowedMentions: latestEntry.allowEveryone
        ? { parse: ['users', 'roles', 'everyone'] }
        : { parse: ['users'] },
    });

    latestEntry.lastMessageId = posted.id;
    latestEntry.updatedAt = Date.now();
    saveStickyMessages();
  } catch (error) {
    console.warn(
      `Failed to repost sticky message in #${channel.name}:`,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    inFlightChannels.delete(channel.id);
  }
}

// Handles incoming messages so active sticky messages stay pinned at the bottom of the channel
export function handleStickyMessageCreate(message: Message): void {
  if (!message.guild) return;
  if (message.author.id === message.client.user?.id) return;
  if (isSupersededLocally() || isInPassiveStandby()) return;

  const entry = stickyStore.get(message.channelId);
  if (!entry) return;
  if (!isSupportedStickyChannel(message.channel)) return;

  const existingTimer = repostTimers.get(message.channelId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const targetChannel = message.channel;
  const timer = setTimeout(() => {
    repostTimers.delete(message.channelId);
    void repostStickyInChannel(targetChannel);
  }, REPOST_DEBOUNCE_MS);

  repostTimers.set(message.channelId, timer);
}

// Handles "/stickymessage <message>" command execution
export async function handleStickyAddCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild || !isSupportedStickyChannel(interaction.channel)) {
    await interaction.reply({
      content: 'This command can only be used inside a server text channel',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
    await interaction.reply({
      content: 'You need the Manage Messages permission to set a sticky message',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const me = interaction.guild.members.me;
  const botPerms = me ? interaction.channel.permissionsFor(me) : null;
  if (!botPerms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    await interaction.reply({
      content: `I do not have permission to send messages in <#${interaction.channel.id}>`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const rawMessage = interaction.options.getString('message', true);
  const formatted = formatStickyContent(rawMessage);
  if (!formatted) {
    await interaction.reply({
      content: 'Sticky message cannot be empty',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const previous = stickyStore.get(interaction.channel.id);
  const pendingTimer = repostTimers.get(interaction.channel.id);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    repostTimers.delete(interaction.channel.id);
  }

  if (previous?.lastMessageId) {
    await tryDeleteStickyMessage(interaction.channel, previous.lastMessageId);
  }

  const allowEveryone = Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.MentionEveryone),
  );

  const posted = await interaction.channel.send({
    content: formatted,
    allowedMentions: allowEveryone
      ? { parse: ['users', 'roles', 'everyone'] }
      : { parse: ['users'] },
  });

  stickyStore.set(interaction.channel.id, {
    guildId: interaction.guild.id,
    channelId: interaction.channel.id,
    content: formatted,
    lastMessageId: posted.id,
    allowEveryone,
    updatedAt: Date.now(),
  });
  saveStickyMessages();

  await interaction.editReply({
    content: `Sticky message added to <#${interaction.channel.id}>`,
  });
}

// Handles "/stickmessage remove <channel>" command execution
export async function handleStickyRemoveCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({
      content: 'This command can only be used inside a server',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
    await interaction.reply({
      content: 'You need the Manage Messages permission to remove a sticky message',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.options.getSubcommand() !== 'remove') return;

  const targetChannel = interaction.options.getChannel('channel', true);
  const entry = stickyStore.get(targetChannel.id);

  if (!entry) {
    await interaction.reply({
      content: `No sticky message is set for <#${targetChannel.id}>`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const pendingTimer = repostTimers.get(targetChannel.id);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    repostTimers.delete(targetChannel.id);
  }

  stickyStore.delete(targetChannel.id);
  saveStickyMessages();

  try {
    const fetched = await interaction.guild.channels.fetch(targetChannel.id);
    if (isSupportedStickyChannel(fetched) && entry.lastMessageId) {
      await tryDeleteStickyMessage(fetched, entry.lastMessageId);
    }
  } catch {
    // Channel may no longer be accessible
  }

  await interaction.editReply({
    content: `Sticky message removed from <#${targetChannel.id}>`,
  });
}
