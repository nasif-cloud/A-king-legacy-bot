import fs from 'node:fs';
import path from 'node:path';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Client,
  ContainerBuilder,
  MessageFlags,
  PermissionsBitField,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type AnyThreadChannel,
  type Collection,
  type Guild,
  type GuildBasedChannel,
  type Interaction,
  type Message,
  type MessageActionRowComponentBuilder,
  type ReadonlyCollection,
} from 'discord.js';
import { isSupersededLocally } from './leadership.js';
import { BOT_OWNER_ID } from './stockReminder.js';

const PREV_EMOJI = { id: '1573694038698098778', name: 'previousbutton' };
const NEXT_EMOJI = { id: '1573694024500519043', name: 'nextbutton' };

export const SERVERS_PER_PAGE = 10;
const ACTIVITY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const THREE_DAYS_MS = 3 * ONE_DAY_MS;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;
const DISCORD_EPOCH_MS = 1420070400000n;

const ACTIVITY_STORE_VERSION = 1;
const SEED_CONCURRENCY = 5;
const SEED_PAGE_LIMIT = 100;
const SEED_MAX_PAGES_PER_CHANNEL = 30;
const SAVE_DEBOUNCE_MS = 2500;
const MAX_TIMESTAMPS_PER_GUILD = 5000;
const MAX_SEEN_MSG_IDS = 100_000;

export interface ActivityTier {
  rating: number;
  minScore: number;
  label: string;
  description: string;
}

export const ACTIVITY_TIERS: readonly ActivityTier[] = [
  {
    rating: 1,
    minScore: 0,
    label: 'Not active at all',
    description: 'No bot activity in the last 14 days',
  },
  {
    rating: 2,
    minScore: 0.01,
    label: 'Barely active',
    description: '1–2 isolated actions in the last 14 days',
  },
  {
    rating: 3,
    minScore: 3,
    label: 'Very low activity',
    description: 'Sporadic usage every several days',
  },
  {
    rating: 4,
    minScore: 8,
    label: 'Low activity',
    description: 'Used a few times per week',
  },
  {
    rating: 5,
    minScore: 18,
    label: 'Moderate activity',
    description: 'Casual usage or regular scheduled updates',
  },
  {
    rating: 6,
    minScore: 40,
    label: 'Fairly active',
    description: 'Consistent daily bot usage',
  },
  {
    rating: 7,
    minScore: 85,
    label: 'Active',
    description: 'Steady activity across commands and messages',
  },
  {
    rating: 8,
    minScore: 160,
    label: 'Very active',
    description: 'Frequent interactions and messages daily',
  },
  {
    rating: 9,
    minScore: 300,
    label: 'Extremely active',
    description: 'Heavy daily traffic across features',
  },
  {
    rating: 10,
    minScore: 600,
    label: 'Constantly active',
    description: 'Non-stop bot activity throughout the day',
  },
] as const;

interface PersistedGuildActivity {
  timestamps: number[];
  seededAt: number;
}

interface PersistedActivityStore {
  version: number;
  guilds: Record<string, PersistedGuildActivity>;
}

function resolveBotActivityPath(): string {
  const explicit = process.env.BOT_ACTIVITY_PATH?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }

  try {
    if (fs.existsSync('/data') && fs.statSync('/data').isDirectory()) {
      fs.accessSync('/data', fs.constants.W_OK);
      return '/data/.bot-activity.json';
    }
  } catch {
    // Fall back to workspace directory
  }

  return path.resolve(process.cwd(), '.bot-activity.json');
}

const ACTIVITY_STORE_PATH = resolveBotActivityPath();

const guildActivityTimestamps = new Map<string, number[]>();
const seededGuilds = new Set<string>();
const seedingInProgress = new Set<string>();
const activeSeedTimestamps = new Map<string, number[]>();
const seenMessageIds = new Set<string>();
let saveTimer: NodeJS.Timeout | null = null;

function rememberMessageId(messageId: string): boolean {
  if (seenMessageIds.has(messageId)) return false;
  if (seenMessageIds.size >= MAX_SEEN_MSG_IDS) {
    let removed = 0;
    for (const id of seenMessageIds) {
      seenMessageIds.delete(id);
      removed += 1;
      if (removed >= 10_000) break;
    }
  }
  seenMessageIds.add(messageId);
  return true;
}

function snowflakeToTimestamp(id: string | null | undefined): number | null {
  if (!id) return null;
  try {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
  } catch {
    return null;
  }
}

function pruneTimestamps(timestamps: number[], nowMs = Date.now()): number[] {
  const cutoff = nowMs - ACTIVITY_WINDOW_MS;
  const fresh = timestamps.filter(
    (ts) => typeof ts === 'number' && Number.isFinite(ts) && ts >= cutoff && ts <= nowMs + 60_000,
  );
  if (fresh.length > MAX_TIMESTAMPS_PER_GUILD) {
    fresh.sort((a, b) => a - b);
    return fresh.slice(fresh.length - MAX_TIMESTAMPS_PER_GUILD);
  }
  return fresh;
}

export function loadBotActivity(storePath = ACTIVITY_STORE_PATH): void {
  guildActivityTimestamps.clear();
  seededGuilds.clear();

  try {
    if (!fs.existsSync(storePath)) return;
    const raw = fs.readFileSync(storePath, 'utf8').trim();
    if (!raw) return;

    const parsed = JSON.parse(raw) as Partial<PersistedActivityStore>;
    if (parsed?.version !== ACTIVITY_STORE_VERSION || !parsed.guilds) return;

    const nowMs = Date.now();
    for (const [guildId, entry] of Object.entries(parsed.guilds)) {
      if (!entry || !Array.isArray(entry.timestamps)) continue;
      const pruned = pruneTimestamps(entry.timestamps, nowMs);
      guildActivityTimestamps.set(guildId, pruned);
      if (typeof entry.seededAt === 'number' && entry.seededAt > 0) {
        seededGuilds.add(guildId);
      }
    }
  } catch (error) {
    console.warn('[ServList] Failed to load bot activity store:', error);
  }
}

export function saveBotActivity(storePath = ACTIVITY_STORE_PATH): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  try {
    const dir = path.dirname(storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const nowMs = Date.now();
    const guildsRecord: Record<string, PersistedGuildActivity> = {};
    const allIds = new Set<string>([
      ...guildActivityTimestamps.keys(),
      ...seededGuilds.values(),
    ]);

    for (const guildId of allIds) {
      const pruned = pruneTimestamps(guildActivityTimestamps.get(guildId) ?? [], nowMs);
      guildActivityTimestamps.set(guildId, pruned);
      guildsRecord[guildId] = {
        timestamps: pruned,
        seededAt: seededGuilds.has(guildId) ? nowMs : 0,
      };
    }

    const payload: PersistedActivityStore = {
      version: ACTIVITY_STORE_VERSION,
      guilds: guildsRecord,
    };
    const tmpPath = `${storePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmpPath, storePath);
  } catch (error) {
    console.warn('[ServList] Failed to save bot activity store:', error);
  }
}

function scheduleSaveActivity(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveBotActivity();
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref();
}

export function recordGuildActivityEvent(guildId: string, timestampMs = Date.now()): void {
  if (!guildId) return;
  const list = guildActivityTimestamps.get(guildId) ?? [];
  list.push(timestampMs);

  // Periodically prune oversized arrays in memory
  if (list.length > MAX_TIMESTAMPS_PER_GUILD + 500) {
    guildActivityTimestamps.set(guildId, pruneTimestamps(list, timestampMs));
  } else {
    guildActivityTimestamps.set(guildId, list);
  }

  const activeSeed = activeSeedTimestamps.get(guildId);
  if (activeSeed) {
    activeSeed.push(timestampMs);
  }

  scheduleSaveActivity();
}

export function trackBotMessageCreate(message: Message): void {
  const botId = message.client.user?.id;
  if (!botId || !message.guildId) return;
  if (message.author?.id !== botId) return;

  // Exclude owner inspection command replies so checking klservlist doesn't skew activity
  const replyRef = message.reference?.messageId;
  if (message.content.includes('## Server List') && replyRef) {
    return;
  }

  if (!rememberMessageId(message.id)) return;
  recordGuildActivityEvent(message.guildId, message.createdTimestamp || Date.now());
}

export function trackBotInteraction(interaction: Interaction): void {
  if (!interaction.guildId) return;
  if (interaction.isAutocomplete()) return;
  if ('customId' in interaction && interaction.customId.startsWith('klsrv:')) {
    return;
  }
  recordGuildActivityEvent(interaction.guildId, interaction.createdTimestamp || Date.now());
}

export function computeActivityScore(timestamps: number[], nowMs = Date.now()): number {
  const cutoff = nowMs - ACTIVITY_WINDOW_MS;
  let score = 0;

  for (const ts of timestamps) {
    if (ts < cutoff) continue;
    const age = Math.max(0, nowMs - ts);
    if (age <= ONE_DAY_MS) {
      score += 1.0;
    } else if (age <= THREE_DAYS_MS) {
      score += 0.7;
    } else if (age <= SEVEN_DAYS_MS) {
      score += 0.4;
    } else {
      score += 0.15;
    }
  }

  return score;
}

export function getActivityTierForScore(score: number): ActivityTier {
  if (score <= 0) return ACTIVITY_TIERS[0];

  let matched = ACTIVITY_TIERS[1];
  for (const tier of ACTIVITY_TIERS) {
    if (score >= tier.minScore) {
      matched = tier;
    } else {
      break;
    }
  }
  return matched;
}

export function getGuildActivityRating(
  guildId: string,
  nowMs = Date.now(),
): {
  rating: number;
  label: string;
  score: number;
  events14d: number;
} {
  const pruned = pruneTimestamps(guildActivityTimestamps.get(guildId) ?? [], nowMs);
  guildActivityTimestamps.set(guildId, pruned);
  const score = computeActivityScore(pruned, nowMs);
  const tier = getActivityTierForScore(score);
  return {
    rating: tier.rating,
    label: tier.label,
    score,
    events14d: pruned.length,
  };
}

export function isGuildSeedPending(guildId: string): boolean {
  return seedingInProgress.has(guildId);
}

export function setGuildActivityTimestampsForTest(
  guildId: string,
  timestamps: number[],
  markSeeded = true,
): void {
  guildActivityTimestamps.set(guildId, pruneTimestamps(timestamps));
  if (markSeeded) {
    seededGuilds.add(guildId);
  }
}

export function resetBotActivityForTest(): void {
  guildActivityTimestamps.clear();
  seededGuilds.clear();
  seedingInProgress.clear();
  activeSeedTimestamps.clear();
  seenMessageIds.clear();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

type MessageReadableChannel = GuildBasedChannel & {
  lastMessageId?: string | null;
  messages: {
    fetch: (options: {
      limit: number;
      before?: string;
    }) => Promise<Collection<string, Message>>;
  };
};

function isMessageReadableChannel(
  ch: GuildBasedChannel | AnyThreadChannel,
): ch is MessageReadableChannel {
  return ch.isTextBased() && !ch.isDMBased() && 'messages' in ch;
}

function findOldestSnowflakeId(ids: Iterable<string>): string | undefined {
  let minId: string | undefined;
  let minVal: bigint | undefined;

  for (const id of ids) {
    try {
      const val = BigInt(id);
      if (minVal === undefined || val < minVal) {
        minVal = val;
        minId = id;
      }
    } catch {
      // Skip non-numeric IDs
    }
  }

  return minId;
}

async function fetchRecentArchivedThreads(
  channel: GuildBasedChannel,
  canManageThreads: boolean,
  cutoffMs: number,
): Promise<AnyThreadChannel[]> {
  if (!('threads' in channel) || !channel.threads) return [];

  const collected: AnyThreadChannel[] = [];

  const scanArchiveType = async (mode: 'public' | 'private') => {
    let before: string | undefined;
    while (true) {
      let batch: {
        threads: ReadonlyCollection<string, AnyThreadChannel>;
        hasMore?: boolean;
      } | null = null;

      if (mode === 'public') {
        batch = await channel.threads
          .fetchArchived({ type: 'public', limit: 100, before })
          .catch(() => null);
      } else if (canManageThreads) {
        batch = await channel.threads
          .fetchArchived({ type: 'private', limit: 100, before })
          .catch(() => null);
      } else if (
        'fetchJoinedPrivateArchivedThreads' in channel.threads &&
        typeof (channel.threads as { fetchJoinedPrivateArchivedThreads?: unknown })
          .fetchJoinedPrivateArchivedThreads === 'function'
      ) {
        const textThreads = channel.threads as {
          fetchJoinedPrivateArchivedThreads: (opts: {
            limit: number;
            before?: string;
          }) => Promise<{
            threads: ReadonlyCollection<string, AnyThreadChannel>;
            hasMore?: boolean;
          }>;
        };
        batch = await textThreads
          .fetchJoinedPrivateArchivedThreads({ limit: 100, before })
          .catch(() => null);
      }

      if (!batch || batch.threads.size === 0) break;

      let reachedOldArchives = false;
      for (const thread of batch.threads.values()) {
        const archiveTs =
          thread.archiveTimestamp ?? snowflakeToTimestamp(thread.lastMessageId);
        if (archiveTs !== null && archiveTs < cutoffMs) {
          reachedOldArchives = true;
          continue;
        }
        collected.push(thread);
      }

      if (!batch.hasMore || reachedOldArchives) break;
      const oldest = findOldestSnowflakeId(batch.threads.keys());
      if (!oldest || oldest === before) break;
      before = oldest;
    }
  };

  await scanArchiveType('public');
  await scanArchiveType('private');
  return collected;
}

async function scanChannelRecentActivity(
  channel: MessageReadableChannel,
  botId: string,
  cutoffMs: number,
  collectedTimestamps: number[],
): Promise<void> {
  // Instant zero-API skip if the channel's newest message is older than 14 days
  const lastMsgTs = snowflakeToTimestamp(channel.lastMessageId);
  if (lastMsgTs !== null && lastMsgTs < cutoffMs) {
    return;
  }

  let before: string | undefined;
  let pages = 0;

  while (pages < SEED_MAX_PAGES_PER_CHANNEL) {
    let fetched: Collection<string, Message> | Error | null = await channel.messages
      .fetch({ limit: SEED_PAGE_LIMIT, before })
      .catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));

    if (fetched instanceof Error) {
      const code = (fetched as { code?: number }).code;
      if (code === 50001 || code === 50013 || code === 10003) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      fetched = await channel.messages
        .fetch({ limit: SEED_PAGE_LIMIT, before })
        .catch(() => null);
      if (!fetched || fetched instanceof Error) break;
    }

    if (fetched.size === 0) break;

    let hitCutoff = false;
    for (const msg of fetched.values()) {
      const msgTs = msg.createdTimestamp;
      if (msgTs < cutoffMs) {
        hitCutoff = true;
        continue;
      }
      if (msg.author?.id === botId && rememberMessageId(msg.id)) {
        collectedTimestamps.push(msgTs);
      }
    }

    if (hitCutoff || fetched.size < SEED_PAGE_LIMIT) break;
    const oldestId = findOldestSnowflakeId(fetched.keys());
    if (!oldestId || oldestId === before) break;
    before = oldestId;
    pages += 1;
  }
}

export async function seedGuildActivity(
  client: Client,
  guild: Guild,
  force = false,
): Promise<void> {
  const botId = client.user?.id;
  if (!botId) return;
  if (!force && seededGuilds.has(guild.id)) return;
  if (seedingInProgress.has(guild.id)) return;

  seedingInProgress.add(guild.id);
  activeSeedTimestamps.set(guild.id, []);

  try {
    const nowMs = Date.now();
    const cutoffMs = nowMs - ACTIVITY_WINDOW_MS;

    const me =
      guild.members.me ??
      (await guild.members.fetchMe().catch(() => null));

    const fetchedChannels = await guild.channels.fetch().catch(() => null);
    const baseChannels = [...(fetchedChannels ?? guild.channels.cache).values()].filter(
      (ch): ch is GuildBasedChannel => Boolean(ch),
    );

    const activeThreadsResult = await guild.channels
      .fetchActiveThreads()
      .catch(() => null);

    const channelsById = new Map<string, MessageReadableChannel>();

    const registerIfReadable = (ch: GuildBasedChannel | AnyThreadChannel) => {
      if (!isMessageReadableChannel(ch)) return;
      if (me && 'permissionsFor' in ch) {
        const perms = ch.permissionsFor(me);
        if (
          perms &&
          !perms.has([
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.ReadMessageHistory,
          ])
        ) {
          return;
        }
      }
      channelsById.set(ch.id, ch);
    };

    for (const ch of baseChannels) {
      registerIfReadable(ch);
    }

    if (activeThreadsResult) {
      for (const thread of activeThreadsResult.threads.values()) {
        registerIfReadable(thread);
      }
    }

    const threadParents = baseChannels.filter((ch) => 'threads' in ch && Boolean(ch.threads));
    for (let i = 0; i < threadParents.length; i += SEED_CONCURRENCY) {
      const batch = threadParents.slice(i, i + SEED_CONCURRENCY);
      const archivedLists = await Promise.all(
        batch.map((parent) => {
          const perms = me && 'permissionsFor' in parent ? parent.permissionsFor(me) : null;
          if (
            perms &&
            !perms.has([
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.ReadMessageHistory,
            ])
          ) {
            return Promise.resolve([] as AnyThreadChannel[]);
          }
          const canManageThreads = Boolean(
            perms?.has(PermissionsBitField.Flags.ManageThreads),
          );
          return fetchRecentArchivedThreads(parent, canManageThreads, cutoffMs);
        }),
      );
      for (const threads of archivedLists) {
        for (const thread of threads) {
          registerIfReadable(thread);
        }
      }
    }

    const seededTimestamps: number[] = [];
    const scanList = [...channelsById.values()];

    for (let i = 0; i < scanList.length; i += SEED_CONCURRENCY) {
      const batch = scanList.slice(i, i + SEED_CONCURRENCY);
      await Promise.all(
        batch.map((ch) =>
          scanChannelRecentActivity(ch, botId, cutoffMs, seededTimestamps),
        ),
      );
    }

    const liveDuringSeed = activeSeedTimestamps.get(guild.id) ?? [];
    const existing = force ? [] : (guildActivityTimestamps.get(guild.id) ?? []);
    const merged = pruneTimestamps(
      [...existing, ...seededTimestamps, ...liveDuringSeed],
      Date.now(),
    );

    guildActivityTimestamps.set(guild.id, merged);
    seededGuilds.add(guild.id);
    saveBotActivity();
  } catch (error) {
    console.warn(`[ServList] Failed to seed activity for guild ${guild.id}:`, error);
  } finally {
    activeSeedTimestamps.delete(guild.id);
    seedingInProgress.delete(guild.id);
  }
}

export async function seedBotActivity(
  client: Client,
  targetGuildId?: string,
  force = false,
): Promise<void> {
  if (!client.user?.id) return;

  if (targetGuildId) {
    const guild = client.guilds.cache.get(targetGuildId);
    if (guild) {
      await seedGuildActivity(client, guild, force);
    }
    return;
  }

  // Seed largest servers first so top servers on page 1 reflect full 14d activity immediately
  const guilds = [...client.guilds.cache.values()].sort(
    (a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0),
  );

  for (const guild of guilds) {
    if (force || !seededGuilds.has(guild.id)) {
      await seedGuildActivity(client, guild, force);
    }
  }
}

function sanitizeServerName(name: string): string {
  const cleaned = name
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/@/g, '@\u200b')
    .replace(/([\\`*_~|[\]])/g, '\\$1')
    .trim();
  if (!cleaned) return 'Unknown Server';
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
}

export interface ServerListEntry {
  id: string;
  name: string;
  memberCount: number;
  rating: number;
  label: string;
  score: number;
  syncing: boolean;
}

export function getSortedServerEntries(client: Client): ServerListEntry[] {
  const nowMs = Date.now();
  return [...client.guilds.cache.values()]
    .map((guild) => {
      const activity = getGuildActivityRating(guild.id, nowMs);
      return {
        id: guild.id,
        name: guild.name,
        memberCount: guild.memberCount ?? 0,
        rating: activity.rating,
        label: activity.label,
        score: activity.score,
        syncing: isGuildSeedPending(guild.id),
      };
    })
    .sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name));
}

export function buildServListPayload(
  client: Client,
  requestedPage = 0,
): {
  flags: MessageFlags.IsComponentsV2;
  components: [ContainerBuilder];
  allowedMentions: { parse: never[]; repliedUser: false };
} {
  const entries = getSortedServerEntries(client);
  const totalServers = entries.length;
  const totalPages = Math.max(1, Math.ceil(totalServers / SERVERS_PER_PAGE));
  const safePage = Math.max(0, Math.min(requestedPage, totalPages - 1));
  const startIndex = safePage * SERVERS_PER_PAGE;
  const pageEntries = entries.slice(startIndex, startIndex + SERVERS_PER_PAGE);

  const anySyncing = entries.some((entry) => entry.syncing);

  const bodyLines =
    pageEntries.length > 0
      ? pageEntries
          .map((entry, idx) => {
            const rank = startIndex + idx + 1;
            const safeName = sanitizeServerName(entry.name);
            const syncTag = entry.syncing ? ' *(syncing...)*' : '';
            return `**${rank}. ${safeName}**\n-# Members: **${entry.memberCount.toLocaleString('en-US')}** • Activity: **${entry.rating}/10** (${entry.label})${syncTag}`;
          })
          .join('\n')
      : '-# The bot is not currently in any servers.';

  const navRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`klsrv:prev:${safePage}`)
      .setLabel('Previous')
      .setEmoji(PREV_EMOJI)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage <= 0),
    new ButtonBuilder()
      .setCustomId(`klsrv:next:${safePage}`)
      .setLabel('Next')
      .setEmoji(NEXT_EMOJI)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= totalPages - 1),
    new ButtonBuilder()
      .setCustomId('klsrv:scale')
      .setLabel('Activity Scale')
      .setStyle(ButtonStyle.Primary),
  );

  const footerText = anySyncing
    ? '-# Filtered from highest member count to lowest • Syncing 14-day activity'
    : '-# Filtered from highest member count to lowest';

  const container = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## Server List\n-# Total Servers: **${totalServers.toLocaleString('en-US')}** • Page **${safePage + 1}/${totalPages}**`,
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(bodyLines))
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(footerText))
    .addActionRowComponents(navRow);

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [], repliedUser: false },
  };
}

export function buildActivityScalePayload(): {
  flags: number;
  components: [ContainerBuilder];
  allowedMentions: { parse: never[] };
} {
  const scaleLines = ACTIVITY_TIERS.map(
    (tier) => `**${tier.rating}/10** = **${tier.label}** — *${tier.description}*`,
  ).join('\n');

  const container = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('## Bot Activity Rankings (1/10 – 10/10)'),
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(scaleLines))
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '-# Rated from rolling 14-day recency-weighted bot commands, interactions, and messages.',
      ),
    );

  return {
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    components: [container],
    allowedMentions: { parse: [] },
  };
}

export async function handleServListMessage(message: Message): Promise<boolean> {
  if (!message.author || message.author.bot) return false;
  if (message.author.id !== BOT_OWNER_ID) return false;

  const trimmed = message.content.trim();
  const match = /^klservlist(?:\s+(rescan|recount|\d+))?$/i.exec(trimmed);
  if (!match) return false;

  if (isSupersededLocally()) return false;

  const arg = match[1]?.toLowerCase();
  if (arg === 'rescan' || arg === 'recount') {
    void seedBotActivity(message.client, undefined, true);
  }

  const parsedPage =
    arg && /^\d+$/.test(arg) ? Math.max(0, Number.parseInt(arg, 10) - 1) : 0;
  const payload = buildServListPayload(message.client, parsedPage);

  try {
    await message.reply(payload);
    return true;
  } catch {
    if ('send' in message.channel && typeof message.channel.send === 'function') {
      await message.channel.send(payload).catch(() => null);
      return true;
    }
    return false;
  }
}

export async function handleServListButton(interaction: ButtonInteraction): Promise<void> {
  if (interaction.user.id !== BOT_OWNER_ID) {
    await interaction.reply({
      content: 'Only the bot owner can use this command.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const parts = interaction.customId.split(':');
  if (parts.length < 2 || parts[0] !== 'klsrv') return;

  const action = parts[1];
  if (action === 'scale') {
    await interaction.reply(buildActivityScalePayload());
    return;
  }

  const currentPage = Number.parseInt(parts[2] ?? '0', 10);
  const safeCurrent = Number.isFinite(currentPage) ? currentPage : 0;
  const nextPage = action === 'prev' ? safeCurrent - 1 : safeCurrent + 1;

  await interaction.update(buildServListPayload(interaction.client, nextPage));
}
