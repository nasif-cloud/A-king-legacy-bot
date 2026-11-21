import fs from 'node:fs';
import path from 'node:path';
import {
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  Message,
  MessageFlags,
  PartialMessage,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type GuildTextBasedChannel,
  type Snowflake,
} from 'discord.js';
import { isSupersededLocally } from './leadership.js';

interface StickyEntry {
  guildId: string;
  channelId: string;
  content: string;
  lastMessageId: string | null;
  allowEveryone: boolean;
  updatedAt: number;
}

const REPOST_DEBOUNCE_MS = 1200;
const WATCHDOG_INTERVAL_MS = 60_000;
const RECOVERY_SCAN_PAGES = 2; // Up to 200 recent messages per channel on cold recovery

// Invisible zero-width suffix appended to posted sticky messages so they can be recovered even if disk state is wiped
const STICKY_MARKER_DEFAULT = ' \u200b\u200c\u200d\u200b';
const STICKY_MARKER_EVERYONE = ' \u200b\u200c\u200d\u200c';
const STICKY_MARKER_REGEX = / ?\u200b\u200c\u200d[\u200b\u200c]$/;

// Resolves the most persistent writable path for .sticky-messages.json
function resolveStickyStorePath(): string {
  const explicit = process.env.STICKY_STORE_PATH?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }

  // Prefer persistent volume mount (/data) on cloud hosts (Railway, Fly, Render) if available and writable
  try {
    if (fs.existsSync('/data') && fs.statSync('/data').isDirectory()) {
      fs.accessSync('/data', fs.constants.W_OK);
      return '/data/.sticky-messages.json';
    }
  } catch {
    // Fall back to workspace directory
  }

  return path.resolve(process.cwd(), '.sticky-messages.json');
}

const STICKY_STORE_PATH = resolveStickyStorePath();

// In-memory store keyed by channelId supporting unlimited sticky messages across servers
const stickyStore = new Map<string, StickyEntry>();
const repostTimers = new Map<string, NodeJS.Timeout>();
const inFlightChannels = new Set<string>();
const dirtyChannels = new Set<string>();
const deletingMessageIds = new Set<string>();
const removedChannels = new Set<string>();
let watchdogTimer: NodeJS.Timeout | null = null;
let reconcilePromise: Promise<void> | null = null;

function stripStickyMarker(text: string): string {
  return text.replace(STICKY_MARKER_REGEX, '').trim();
}

function detectStickyMarker(text: string): {
  isSticky: boolean;
  allowEveryone: boolean;
  cleanContent: string;
} {
  if (text.endsWith('\u200b\u200c\u200d\u200c')) {
    return {
      isSticky: true,
      allowEveryone: true,
      cleanContent: stripStickyMarker(text),
    };
  }
  if (text.endsWith('\u200b\u200c\u200d\u200b')) {
    return {
      isSticky: true,
      allowEveryone: false,
      cleanContent: stripStickyMarker(text),
    };
  }
  return {
    isSticky: false,
    allowEveryone: false,
    cleanContent: text,
  };
}

function encodeStickyContent(rawContent: string, allowEveryone: boolean): string {
  const clean = stripStickyMarker(rawContent);
  const marker = allowEveryone ? STICKY_MARKER_EVERYONE : STICKY_MARKER_DEFAULT;
  const maxBodyLen = 2000 - marker.length;
  return `${clean.slice(0, maxBodyLen)}${marker}`;
}

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
        stickyStore.set(entry.channelId, {
          ...entry,
          content: stripStickyMarker(entry.content),
        });
      }
    }
    if (stickyStore.size > 0) {
      console.log(`[Sticky] Loaded ${stickyStore.size} sticky message(s) from ${STICKY_STORE_PATH}`);
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
    const dir = path.dirname(STICKY_STORE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const entries = [...stickyStore.values()].map((entry) => ({
      ...entry,
      content: stripStickyMarker(entry.content),
    }));
    const tmpPath = `${STICKY_STORE_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), 'utf8');
    fs.renameSync(tmpPath, STICKY_STORE_PATH);
  } catch (error) {
    console.warn(
      'Could not save sticky messages store:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

// Converts escaped "\n" into real newlines while preserving all Discord markdown (#, -#, **, __, emojis, etc.)
function formatStickyContent(rawText: string): string {
  return stripStickyMarker(rawText.replace(/\\n/g, '\n')).slice(0, 1995);
}

// Checks whether a channel supports sending sticky messages
function isSupportedStickyChannel(channel: unknown): channel is GuildTextBasedChannel {
  if (!channel || typeof channel !== 'object') return false;
  const ch = channel as { type?: ChannelType; isTextBased?: () => boolean; isDMBased?: () => boolean };
  return Boolean(ch.isTextBased?.() && !ch.isDMBased?.());
}

function getRequiredSendPermission(channel: GuildTextBasedChannel): bigint {
  return channel.isThread()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
}

async function resolveBotMember(channel: GuildTextBasedChannel) {
  return (
    channel.guild.members.me ??
    (await channel.guild.members.fetchMe().catch(() => null))
  );
}

function markMessageDeleting(messageId: string): void {
  deletingMessageIds.add(messageId);
  setTimeout(() => {
    deletingMessageIds.delete(messageId);
  }, 15_000).unref();
}

// Slash command: /stickymessage <message>
export const stickyAddCommandData = new SlashCommandBuilder()
  .setName('stickymessage')
  .setDescription('add a sticky message to a channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((option) =>
    option
      .setName('message')
      .setDescription('message text (supports Discord markdown like #, -#, **bold**, and \\n)')
      .setRequired(true)
      .setMaxLength(1995),
  );

// Slash command: /stickmessage remove <channel>
export const stickyRemoveCommandData = new SlashCommandBuilder()
  .setName('stickmessage')
  .setDescription('remove a sticky message from a channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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
  markMessageDeleting(messageId);
  try {
    await channel.messages.delete(messageId);
  } catch {
    // Ignore if already deleted or missing permissions
  }
}

// Moves the sticky message to the bottom of the channel reliably
async function repostStickyInChannel(channel: GuildTextBasedChannel): Promise<void> {
  const entry = stickyStore.get(channel.id);
  if (!entry) return;
  if (isSupersededLocally()) return;

  if (inFlightChannels.has(channel.id)) {
    dirtyChannels.add(channel.id);
    return;
  }

  inFlightChannels.add(channel.id);
  try {
    const latestEntry = stickyStore.get(channel.id);
    if (!latestEntry) return;

    const me = await resolveBotMember(channel);
    const perms = me ? channel.permissionsFor(me) : null;
    if (
      !perms?.has([
        PermissionFlagsBits.ViewChannel,
        getRequiredSendPermission(channel),
      ])
    ) {
      return;
    }

    const cleanTarget = stripStickyMarker(latestEntry.content);
    let alreadyAtBottom = false;

    // Check recent messages so we don't duplicate if the sticky message is already the newest message
    try {
      const recent = await channel.messages.fetch({ limit: 5 });
      const newest = recent.first();
      const botId = channel.client.user?.id;

      if (
        newest &&
        newest.author.id === botId &&
        stripStickyMarker(newest.content) === cleanTarget
      ) {
        alreadyAtBottom = true;
        latestEntry.lastMessageId = newest.id;
        saveStickyMessages();
      }

      // Clean up any older sticky copies found in the recent window
      for (const msg of recent.values()) {
        if (alreadyAtBottom && msg.id === newest?.id) continue;
        if (
          msg.author.id === botId &&
          (msg.id === latestEntry.lastMessageId ||
            stripStickyMarker(msg.content) === cleanTarget)
        ) {
          await tryDeleteStickyMessage(channel, msg.id);
        }
      }

      if (alreadyAtBottom) {
        return;
      }
    } catch {
      await tryDeleteStickyMessage(channel, latestEntry.lastMessageId);
    }

    // Ensure the tracked lastMessageId is deleted even if buried deeper than 5 messages
    if (latestEntry.lastMessageId) {
      await tryDeleteStickyMessage(channel, latestEntry.lastMessageId);
    }

    // Re-check that sticky wasn't removed while deleting old copies
    const activeEntry = stickyStore.get(channel.id);
    if (!activeEntry || isSupersededLocally()) return;

    const posted = await channel.send({
      content: encodeStickyContent(activeEntry.content, activeEntry.allowEveryone),
      allowedMentions: activeEntry.allowEveryone
        ? { parse: ['users', 'roles', 'everyone'] }
        : { parse: ['users'] },
    });

    activeEntry.lastMessageId = posted.id;
    activeEntry.updatedAt = Date.now();
    saveStickyMessages();
  } catch (error) {
    console.warn(
      `Failed to repost sticky message in #${channel.name}:`,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    inFlightChannels.delete(channel.id);
    if (dirtyChannels.delete(channel.id) && stickyStore.has(channel.id)) {
      scheduleStickyRepost(channel, 350);
    }
  }
}

function scheduleStickyRepost(
  channel: GuildTextBasedChannel,
  delayMs = REPOST_DEBOUNCE_MS,
): void {
  if (!stickyStore.has(channel.id)) return;
  if (isSupersededLocally()) return;

  const existingTimer = repostTimers.get(channel.id);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    repostTimers.delete(channel.id);
    void repostStickyInChannel(channel);
  }, delayMs);

  repostTimers.set(channel.id, timer);
}

// Handles incoming messages so active sticky messages stay pinned at the bottom of the channel
export function handleStickyMessageCreate(message: Message): void {
  if (!message.guild) return;
  if (isSupersededLocally()) return;

  const entry = stickyStore.get(message.channelId);
  if (!entry) return;
  if (!isSupportedStickyChannel(message.channel)) return;

  // Ignore the sticky message itself, but still repost if the bot sent a command reply (/value, /wl, etc.)
  if (
    message.author.id === message.client.user?.id &&
    (message.id === entry.lastMessageId ||
      stripStickyMarker(message.content) === stripStickyMarker(entry.content))
  ) {
    return;
  }

  scheduleStickyRepost(message.channel, REPOST_DEBOUNCE_MS);
}

// Immediately reposts the sticky message if someone manually deletes it
export function handleStickyMessageDelete(message: Message | PartialMessage): void {
  if (!message.guildId) return;
  if (isSupersededLocally()) return;
  if (deletingMessageIds.has(message.id)) return;

  const entry = stickyStore.get(message.channelId);
  if (!entry) return;
  if (entry.lastMessageId && message.id !== entry.lastMessageId) return;
  if (!isSupportedStickyChannel(message.channel)) return;

  entry.lastMessageId = null;
  saveStickyMessages();
  scheduleStickyRepost(message.channel, 250);
}

// Immediately reposts the sticky message if a bulk purge deletes messages in a sticky channel
export function handleStickyMessageBulkDelete(
  messages: ReadonlyMap<Snowflake, Message | PartialMessage>,
): void {
  const first = messages.values().next().value;
  if (!first?.guildId || !isSupportedStickyChannel(first.channel)) return;
  if (isSupersededLocally()) return;

  const entry = stickyStore.get(first.channelId);
  if (!entry) return;

  if (!entry.lastMessageId || messages.has(entry.lastMessageId)) {
    entry.lastMessageId = null;
    saveStickyMessages();
    scheduleStickyRepost(first.channel, 350);
  }
}

// Checks whether the newest message in a sticky channel is still our sticky message; reposts if buried/missing
async function verifyChannelStickyAtBottom(
  channel: GuildTextBasedChannel,
  entry: StickyEntry,
): Promise<void> {
  if (inFlightChannels.has(channel.id) || repostTimers.has(channel.id)) return;

  const me = await resolveBotMember(channel);
  const perms = me ? channel.permissionsFor(me) : null;
  if (
    !perms?.has([
      PermissionFlagsBits.ViewChannel,
      getRequiredSendPermission(channel),
    ])
  ) {
    return;
  }

  const cleanTarget = stripStickyMarker(entry.content);
  try {
    const latest = await channel.messages.fetch({ limit: 1 });
    const newest = latest.first();
    if (
      newest &&
      newest.author.id === channel.client.user?.id &&
      stripStickyMarker(newest.content) === cleanTarget
    ) {
      if (entry.lastMessageId !== newest.id) {
        entry.lastMessageId = newest.id;
        saveStickyMessages();
      }
      return;
    }
  } catch {
    // If ReadMessageHistory isn't available, avoid blind spamming during watchdog
    return;
  }

  await repostStickyInChannel(channel);
}

// Scans a channel's recent messages for a sticky marker to recover sticky messages after container/disk resets
async function recoverStickyFromChannelHistory(
  channel: GuildTextBasedChannel,
  botUserId: string,
): Promise<StickyEntry | null> {
  try {
    let beforeId: string | undefined;
    for (let page = 0; page < RECOVERY_SCAN_PAGES; page++) {
      const batch = await channel.messages.fetch(
        beforeId ? { limit: 100, before: beforeId } : { limit: 100 },
      );
      if (batch.size === 0) break;

      for (const msg of batch.values()) {
        if (msg.author.id !== botUserId) continue;
        const detected = detectStickyMarker(msg.content);
        if (detected.isSticky && detected.cleanContent) {
          const recovered: StickyEntry = {
            guildId: channel.guild.id,
            channelId: channel.id,
            content: detected.cleanContent,
            lastMessageId: msg.id,
            allowEveryone: detected.allowEveryone,
            updatedAt: msg.createdTimestamp,
          };
          return recovered;
        }
      }

      if (batch.size < 100) break;
      beforeId = batch.last()?.id;
      if (!beforeId) break;
    }
  } catch {
    // Ignore channels where history cannot be fetched
  }
  return null;
}

// Reconciles saved sticky messages on startup/reconnect and recovers any lost disk entries from Discord
export async function reconcileStickyMessages(
  client: Client,
  onlyGuildId?: string,
): Promise<void> {
  if (!client.isReady() || isSupersededLocally()) return;

  startStickyWatchdog(client);

  if (reconcilePromise) {
    return reconcilePromise;
  }

  reconcilePromise = (async () => {
    try {
      const botUserId = client.user?.id;
      if (!botUserId) return;

      // 1) Verify and repost any entries already loaded from disk
      for (const [channelId, entry] of [...stickyStore.entries()]) {
        if (onlyGuildId && entry.guildId !== onlyGuildId) continue;
        try {
          const ch = await client.channels.fetch(channelId);
          if (isSupportedStickyChannel(ch)) {
            await verifyChannelStickyAtBottom(ch, entry);
          }
        } catch (err) {
          const code = (err as { code?: number })?.code;
          if (code === 10003) {
            // Channel was permanently deleted
            stickyStore.delete(channelId);
            saveStickyMessages();
          }
        }
      }

      // 2) If disk store was wiped on reset, scan readable text channels for marked sticky messages
      const guilds = onlyGuildId
        ? [client.guilds.cache.get(onlyGuildId)].filter(Boolean)
        : [...client.guilds.cache.values()];

      let recoveredCount = 0;
      for (const guild of guilds) {
        if (!guild) continue;
        const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
        if (!me) continue;

        for (const channel of guild.channels.cache.values()) {
          if (!isSupportedStickyChannel(channel)) continue;
          if (stickyStore.has(channel.id) || removedChannels.has(channel.id)) continue;

          const perms = channel.permissionsFor(me);
          if (
            !perms?.has([
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.ReadMessageHistory,
              getRequiredSendPermission(channel),
            ])
          ) {
            continue;
          }

          const recovered = await recoverStickyFromChannelHistory(channel, botUserId);
          if (recovered && !stickyStore.has(channel.id) && !removedChannels.has(channel.id)) {
            stickyStore.set(channel.id, recovered);
            recoveredCount += 1;
            saveStickyMessages();
            await verifyChannelStickyAtBottom(channel, recovered);
          }
        }
      }

      if (recoveredCount > 0) {
        console.log(`[Sticky] Recovered ${recoveredCount} sticky message(s) from Discord history.`);
      }
    } finally {
      reconcilePromise = null;
    }
  })();

  return reconcilePromise;
}

// Periodically verifies all active sticky channels remain at the bottom even if a Gateway event was missed
export function startStickyWatchdog(client: Client): void {
  if (watchdogTimer) return;

  watchdogTimer = setInterval(async () => {
    if (!client.isReady() || isSupersededLocally()) return;

    for (const [channelId, entry] of [...stickyStore.entries()]) {
      try {
        const ch =
          client.channels.cache.get(channelId) ??
          (await client.channels.fetch(channelId));
        if (isSupportedStickyChannel(ch)) {
          await verifyChannelStickyAtBottom(ch, entry);
        }
      } catch {
        // Ignore transient Discord API errors during periodic check
      }
    }
  }, WATCHDOG_INTERVAL_MS);

  watchdogTimer.unref();
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

  if (interaction.user.id !== interaction.guild.ownerId) {
    await interaction.reply({
      content: 'Only the server owner can set a sticky message',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const me = await resolveBotMember(interaction.channel);
  const botPerms = me ? interaction.channel.permissionsFor(me) : null;
  if (
    !botPerms?.has([
      PermissionFlagsBits.ViewChannel,
      getRequiredSendPermission(interaction.channel),
    ])
  ) {
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

  removedChannels.delete(interaction.channel.id);

  const previous = stickyStore.get(interaction.channel.id);
  const pendingTimer = repostTimers.get(interaction.channel.id);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    repostTimers.delete(interaction.channel.id);
  }

  if (previous?.lastMessageId) {
    await tryDeleteStickyMessage(interaction.channel, previous.lastMessageId);
  }

  // Also clean up any older sticky copies still visible in recent messages
  try {
    const recent = await interaction.channel.messages.fetch({ limit: 15 });
    const botId = interaction.client.user?.id;
    for (const msg of recent.values()) {
      if (msg.author.id === botId && detectStickyMarker(msg.content).isSticky) {
        await tryDeleteStickyMessage(interaction.channel, msg.id);
      }
    }
  } catch {
    // Ignore if ReadMessageHistory is unavailable
  }

  const allowEveryone = Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.MentionEveryone),
  );

  const posted = await interaction.channel.send({
    content: encodeStickyContent(formatted, allowEveryone),
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

  if (interaction.user.id !== interaction.guild.ownerId) {
    await interaction.reply({
      content: 'Only the server owner can remove a sticky message',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.options.getSubcommand() !== 'remove') return;

  const targetChannel = interaction.options.getChannel('channel', true);
  let entry = stickyStore.get(targetChannel.id);

  // If disk store missed it before recovery finished, check recent messages directly
  if (!entry) {
    try {
      const fetched = await interaction.guild.channels.fetch(targetChannel.id);
      if (isSupportedStickyChannel(fetched) && interaction.client.user?.id) {
        const recovered = await recoverStickyFromChannelHistory(
          fetched,
          interaction.client.user.id,
        );
        if (recovered) entry = recovered;
      }
    } catch {
      // Ignore inaccessible channel
    }
  }

  if (!entry) {
    await interaction.reply({
      content: `No sticky message is set for <#${targetChannel.id}>`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  removedChannels.add(targetChannel.id);

  const pendingTimer = repostTimers.get(targetChannel.id);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    repostTimers.delete(targetChannel.id);
  }
  dirtyChannels.delete(targetChannel.id);

  stickyStore.delete(targetChannel.id);
  saveStickyMessages();

  try {
    const fetched = await interaction.guild.channels.fetch(targetChannel.id);
    if (isSupportedStickyChannel(fetched)) {
      if (entry.lastMessageId) {
        await tryDeleteStickyMessage(fetched, entry.lastMessageId);
      }
      // Clean up any marked sticky copies so they are never recovered after removal
      const recent = await fetched.messages.fetch({ limit: 25 }).catch(() => null);
      if (recent) {
        const botId = interaction.client.user?.id;
        for (const msg of recent.values()) {
          if (
            msg.author.id === botId &&
            (detectStickyMarker(msg.content).isSticky ||
              stripStickyMarker(msg.content) === stripStickyMarker(entry.content))
          ) {
            await tryDeleteStickyMessage(fetched, msg.id);
          }
        }
      }
    }
  } catch {
    // Channel may no longer be accessible
  }

  await interaction.editReply({
    content: `Sticky message removed from <#${targetChannel.id}>`,
  });
}
