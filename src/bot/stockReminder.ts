import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  ComponentType,
  ContainerBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionsBitField,
  RoleSelectMenuBuilder,
  RoleSelectMenuInteraction,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ApplicationEmoji,
  type Guild,
  type GuildMemberRoleManager,
  type GuildTextBasedChannel,
  type Message,
  type MessageActionRowComponentBuilder,
  type MessageCreateOptions,
  type MessageEditOptions,
} from 'discord.js';
import { isSupersededLocally } from './leadership.js';

export const BOT_OWNER_ID = '1257718161298690119';
export const MAIN_INPUT_ROLE_ID = '1574959472508538910';

const MONEY_EMOJI = '<:money:1574942498298527754>';
const REFRESH_EMOJI = '<:refresh:1574960277563379823>';
const PLUS_EMOJI = { id: '1574961306786861066', name: 'plus' };
const MINUS_EMOJI = { id: '1574961321974300795', name: 'minus' };
export const STOCK_VOTE_REACTIONS = [
  '<:Win:1573737872647786508>',
  '<:loss:1573737870999421058>',
] as const;

// Invisible zero-width markers used to recover configured stock channels & state after ephemeral disk resets
const STOCK_MARKER_MAIN = '\u200b\u200c\u200e\u200c';
const STOCK_MARKER_FOLLOWER = '\u200b\u200c\u200e\u200b';
const STOCK_MARKER_REGEX = /[\u200b\u200c\u200e]+/g;

// King Legacy stock refreshes every 6 hours at 00:00, 06:00, 12:00, and 18:00 UTC
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 60_000;
const RECOVERY_SCAN_BATCH_SIZE = 8;
const RECOVERY_MESSAGES_LIMIT = 15;

export interface LegacyFruitEntry {
  id: string;
  name: string;
  price: string;
  emoji: string;
  specialRoleId?: string;
  aliases: string[];
}

// Legacy Fruits catalog & Black Market Beli prices sourced from king-legacy.fandom.com/wiki/Legacy_Fruits
export const LEGACY_FRUITS_CATALOG: LegacyFruitEntry[] = [
  // Common Fruits
  {
    id: 'spin',
    name: 'Spin Fruit',
    price: '1,700,000',
    emoji: '',
    aliases: ['spin', 'spin fruit', 'guru', 'guru guru'],
  },
  {
    id: 'bomb',
    name: 'Bomb Fruit',
    price: '2,100,000',
    emoji: '<:fruit_bomb:1573525801285062777>',
    aliases: ['bomb', 'bomb fruit', 'bomu'],
  },
  {
    id: 'spike',
    name: 'Spike Fruit',
    price: '2,500,000',
    emoji: '',
    aliases: ['spike', 'spike fruit', 'toge'],
  },

  // Uncommon Fruits
  {
    id: 'barrier',
    name: 'Barrier Fruit',
    price: '3,700,000',
    emoji: '',
    aliases: ['barrier', 'barrier fruit', 'bari'],
  },
  {
    id: 'paw',
    name: 'Paw Fruit',
    price: '3,500,000',
    emoji: '<:fruit_paw:1573525808583151616>',
    aliases: ['paw', 'paw fruit', 'pad', 'pad fruit', 'nikyu'],
  },
  {
    id: 'telekinesis',
    name: 'Telekinesis Fruit',
    price: '2,750,000',
    emoji: '<:fruit_telekinesis:1573525814967017652>',
    aliases: ['telekinesis', 'telekinesis fruit', 'tele', 'reino'],
  },
  {
    id: 'love',
    name: 'Love Fruit',
    price: '6,500,000',
    emoji: '<:fruit_love:1573525806683127958>',
    aliases: ['love', 'love fruit', 'mero'],
  },
  {
    id: 'string',
    name: 'String Fruit',
    price: '5,100,000',
    emoji: '',
    aliases: ['string', 'string fruit', 'ito'],
  },
  {
    id: 'wolf',
    name: 'Wolf Fruit',
    price: '5,250,000',
    emoji: '',
    aliases: ['wolf', 'wolf fruit'],
  },
  {
    id: 'giraffe',
    name: 'Giraffe Fruit',
    price: '4,750,000',
    emoji: '',
    aliases: ['giraffe', 'giraffe fruit'],
  },
  {
    id: 'shadow',
    name: 'Shadow Fruit',
    price: '4,100,000',
    emoji: '',
    aliases: ['shadow', 'shadow fruit', 'kage'],
  },
  {
    id: 'smoke',
    name: 'Smoke Fruit',
    price: '4,000,000',
    emoji: '',
    aliases: ['smoke', 'smoke fruit', 'moku'],
  },

  // Rare Fruits
  {
    id: 'buddha',
    name: 'Buddha Fruit',
    price: '5,500,000',
    emoji: '<:buddha:1573506780497973279>',
    aliases: ['buddha', 'buddha fruit', 'hito', 'daibutsu'],
  },
  {
    id: 'rubber',
    name: 'Rubber Fruit',
    price: '6,250,000',
    emoji: '<:fruit_rubber:1573525810533367858>',
    aliases: ['rubber', 'rubber fruit', 'gomu'],
  },
  {
    id: 'sand',
    name: 'Sand Fruit',
    price: '5,100,000',
    emoji: '',
    aliases: ['sand', 'sand fruit', 'suna'],
  },
  {
    id: 'mammoth',
    name: 'Mammoth Fruit',
    price: '6,250,000',
    emoji: '',
    aliases: ['mammoth', 'mammoth fruit', 'zou'],
  },
  {
    id: 'spinosaurus',
    name: 'Spinosaurus Fruit',
    price: '6,000,000',
    emoji: '<:fruit_spino:1573525812173344880>',
    aliases: ['spinosaurus', 'spinosaurus fruit', 'spino', 'spino fruit'],
  },
  {
    id: 'allosaurus',
    name: 'Allosaurus Fruit',
    price: '6,500,000',
    emoji: '<:fruit_allo:1573525799229989030>',
    aliases: ['allosaurus', 'allosaurus fruit', 'allo', 'allo fruit'],
  },
  {
    id: 'brachiosaurus',
    name: 'Brachiosaurus Fruit',
    price: '5,950,000',
    emoji: '<:fruit_brachio:1573525803117969518>',
    aliases: ['brachiosaurus', 'brachiosaurus fruit', 'brachio', 'brachio fruit'],
  },
  {
    id: 'venom',
    name: 'Venom Fruit',
    price: '6,975,000',
    emoji: '<:fruit_venom:1573525816372105330>',
    aliases: ['venom', 'venom fruit', 'doku'],
  },
  {
    id: 'gravity',
    name: 'Gravity Fruit',
    price: '6,750,000',
    emoji: '<:gravity:1573506778631512216>',
    aliases: ['gravity', 'gravity fruit', 'zushi'],
  },
  {
    id: 'control',
    name: 'Control Fruit',
    price: '6,900,000',
    emoji: '<:fruit_control:1573525804900679740>',
    aliases: ['control', 'control fruit', 'ope'],
  },
  {
    id: 'dark',
    name: 'Dark Fruit',
    price: '7,000,000',
    emoji: '<:dark:1573506776450469958>',
    aliases: ['dark', 'dark fruit', 'yami'],
  },
  {
    id: 'leopard',
    name: 'Leopard Fruit',
    price: '7,500,000',
    emoji: '',
    aliases: ['leopard', 'leopard fruit', 'leo', 'neko'],
  },

  // Epic Fruits
  {
    id: 'rumble',
    name: 'Rumble Fruit',
    price: '12,250,000',
    emoji: '<:rumble:1573506792728698900>',
    aliases: ['rumble', 'rumble fruit', 'goro'],
  },
  {
    id: 'flame',
    name: 'Flame Fruit',
    price: '11,500,000',
    emoji: '<:flame:1573506784918900736>',
    aliases: ['flame', 'flame fruit', 'mera'],
  },
  {
    id: 'magma',
    name: 'Magma Fruit',
    price: '10,500,000',
    emoji: '<:magma:1573506789670920222>',
    aliases: ['magma', 'magma fruit', 'magu'],
  },
  {
    id: 'light',
    name: 'Light Fruit',
    price: '12,500,000',
    emoji: '<:light:1573506787909312594>',
    aliases: ['light', 'light fruit', 'pika'],
  },
  {
    id: 'gas',
    name: 'Gas Fruit',
    price: '9,250,000',
    emoji: '<:gas:1573506791130538144>',
    aliases: ['gas', 'gas fruit', 'gasu'],
  },
  {
    id: 'ice',
    name: 'Ice Fruit',
    price: '8,100,000',
    emoji: '<:ice:1573506781995335710>',
    aliases: ['ice', 'ice fruit', 'hie'],
  },
  {
    id: 'snow',
    name: 'Snow Fruit',
    price: '11,250,000',
    emoji: '<:snow:1573506783367143464>',
    aliases: ['snow', 'snow fruit', 'yuki'],
  },
  {
    id: 'quake',
    name: 'Quake Fruit',
    price: '10,500,000',
    emoji: '<:quake:1573506786516803655>',
    aliases: ['quake', 'quake fruit', 'gura'],
  },
  {
    id: 'magnet',
    name: 'Magnet Fruit',
    price: '11,850,000',
    emoji: '',
    aliases: ['magnet', 'magnet fruit', 'jiki'],
  },
  {
    id: 'gold',
    name: 'Gold Fruit',
    price: '13,500,000',
    emoji: '',
    aliases: ['gold', 'gold fruit', 'goru'],
  },
  {
    id: 'spirit',
    name: 'Spirit Fruit',
    price: '9,000,500',
    emoji: '',
    aliases: ['spirit', 'spirit fruit', 'soru', 'soul'],
  },

  // Legendary / Mythical / Special Ping Fruits
  {
    id: 'phoenix',
    name: 'Phoenix Fruit',
    price: '47,000,000',
    emoji: '<:phoenix:1573506802727919636>',
    specialRoleId: '1487827419099299870',
    aliases: ['phoenix', 'phoenix fruit', 'tori'],
  },
  {
    id: 'gate',
    name: 'Gate Fruit',
    price: '32,000,000',
    emoji: '<:gate:1573506800601272441>',
    specialRoleId: '1487827085564313861',
    aliases: ['gate', 'gate fruit', 'doa', 'portal'],
  },
  {
    id: 'dough',
    name: 'Dough Fruit',
    price: '28,500,000',
    emoji: '<:dough:1573506799653490728>',
    specialRoleId: '1487826766742425682',
    aliases: ['dough', 'dough fruit', 'mochi'],
  },
  {
    id: 'dragon',
    name: 'Dragon Fruit',
    price: '50,000,000',
    emoji: '<:dragon:1573506808000028833>',
    specialRoleId: '1487827613534912532',
    aliases: ['dragon', 'dragon fruit', 'ryu', 'uo'],
  },
  {
    id: 'toy',
    name: 'Toy Fruit',
    price: '45,000,000',
    emoji: '<:toy:1573506793982664884>',
    specialRoleId: '1487826254655787139',
    aliases: ['toy', 'toy fruit', 'hobi'],
  },
  {
    id: 'melody',
    name: 'Melody Fruit',
    price: '33,000,000',
    emoji: '<:melody:1573506796033937418>',
    specialRoleId: '1487826933570998313',
    aliases: ['melody', 'melody fruit', 'molody', 'uta'],
  },
  {
    id: 'demon',
    name: 'Demon Fruit',
    price: '44,000,000',
    emoji: '<:demon:1573506804250312754>',
    specialRoleId: '1487828007249772675',
    aliases: ['demon', 'demon fruit'],
  },
  {
    id: 'tree',
    name: 'Tree Fruit',
    price: '30,000,000',
    emoji: '<:tree:1573506806368571462>',
    specialRoleId: '1487828217351110869',
    aliases: ['tree', 'tree fruit', 'mori'],
  },
  {
    id: 'pter',
    name: 'Pter Fruit',
    price: '51,000,000',
    emoji: '<:pter:1573506797531041852>',
    specialRoleId: '1487828402483237064',
    aliases: ['pter', 'pter fruit', 'pteranodon', 'pterodactyl'],
  },
  {
    id: 'erebus',
    name: 'Erebus Fruit',
    price: '71,000,000',
    emoji: '',
    aliases: ['erebus', 'erebus fruit', 'ereb'],
  },
];

const FRUIT_BY_ID = new Map<string, LegacyFruitEntry>(
  LEGACY_FRUITS_CATALOG.map((fruit) => [fruit.id, fruit]),
);
const FRUIT_BY_NAME_LOWER = new Map<string, LegacyFruitEntry>(
  LEGACY_FRUITS_CATALOG.map((fruit) => [fruit.name.toLowerCase(), fruit]),
);

export interface StockChannelConfig {
  guildId: string;
  channelId: string;
  isMain: boolean;
  activeMessageId: string | null;
  updatedAt: number;
}

export interface GlobalStockState {
  cycleStartMs: number;
  nextRefreshMs: number;
  fruits: string[];
  revision: number;
  updatedAt: number;
}

interface PersistedStockPayload {
  globalStock: GlobalStockState;
  channels: StockChannelConfig[];
}

function resolveStockStorePath(): string {
  const explicit = process.env.STOCK_STORE_PATH?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }

  try {
    if (fs.existsSync('/data') && fs.statSync('/data').isDirectory()) {
      fs.accessSync('/data', fs.constants.W_OK);
      return '/data/.stock-config.json';
    }
  } catch {
    // Fall back to workspace directory
  }

  return path.resolve(process.cwd(), '.stock-config.json');
}

function resolveStockPingsStorePath(): string {
  const explicit = process.env.STOCK_PINGS_STORE_PATH?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }

  try {
    if (fs.existsSync('/data') && fs.statSync('/data').isDirectory()) {
      fs.accessSync('/data', fs.constants.W_OK);
      return '/data/.stock-pings.json';
    }
  } catch {
    // Fall back to workspace directory
  }

  return path.resolve(process.cwd(), '.stock-pings.json');
}

function resolveStockEmojisStorePath(): string {
  const explicit = process.env.STOCK_EMOJIS_STORE_PATH?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }

  try {
    if (fs.existsSync('/data') && fs.statSync('/data').isDirectory()) {
      fs.accessSync('/data', fs.constants.W_OK);
      return '/data/.stock-emojis.json';
    }
  } catch {
    // Fall back to workspace directory
  }

  return path.resolve(process.cwd(), '.stock-emojis.json');
}

const STOCK_STORE_PATH = resolveStockStorePath();
const STOCK_PINGS_STORE_PATH = resolveStockPingsStorePath();
const STOCK_EMOJIS_STORE_PATH = resolveStockEmojisStorePath();

const initialBounds = getCurrentCycleBounds();
let globalStock: GlobalStockState = {
  cycleStartMs: initialBounds.cycleStartMs,
  nextRefreshMs: initialBounds.nextRefreshMs,
  fruits: [],
  revision: 0,
  updatedAt: Date.now(),
};

const stockStore = new Map<string, StockChannelConfig>();
// Per-guild fruit ping role overrides: guildId -> { [fruitId]: roleId | null }
const guildStockPings = new Map<string, Record<string, string | null>>();
// Uploaded Application Emoji strings for fruits without hardcoded server emojis: fruitId -> "<:name:id>"
const dynamicFruitEmojis = new Map<string, string>();
const inFlightChannelUpdates = new Set<string>();
let nextCycleTimer: NodeJS.Timeout | null = null;
let watchdogInterval: NodeJS.Timeout | null = null;
let rolloverRunning = false;
let emojiSyncPromise: Promise<void> | null = null;
let reconcilePromise: Promise<void> | null = null;

export function getFruitEmoji(fruit: LegacyFruitEntry): string {
  return fruit.emoji || dynamicFruitEmojis.get(fruit.id) || '';
}

export function setDynamicFruitEmoji(fruitId: string, emojiTag: string | null): void {
  if (!FRUIT_BY_ID.has(fruitId)) return;
  if (emojiTag && emojiTag.trim()) {
    dynamicFruitEmojis.set(fruitId, emojiTag.trim());
  } else {
    dynamicFruitEmojis.delete(fruitId);
  }
}

interface StockPingSession {
  id: string;
  userId: string;
  guildId: string;
  selectedFruitId: string;
  page: number;
  revision: number;
  createdAt: number;
}

const stockPingSessions = new Map<string, StockPingSession>();
const PING_SESSION_TTL_MS = 15 * 60 * 1000;
const FRUITS_PER_PAGE = 23;
// Order fruits highest-to-lowest rarity so Legendary/Special & Epic appear on Page 1
const FRUITS_PICKER_ORDER: LegacyFruitEntry[] = [...LEGACY_FRUITS_CATALOG].reverse();

export const stockSetCommandData = new SlashCommandBuilder()
  .setName('stockset')
  .setDescription('set stock reminders in a channel');

export const stockPingsCommandData = new SlashCommandBuilder()
  .setName('stockpings')
  .setDescription('configure stock ping roles for each fruit');

export function getEffectiveFruitPingRoleId(
  guildId: string,
  fruitId: string,
  guild?: Guild | null,
): string | null {
  const overrides = guildStockPings.get(guildId);
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, fruitId)) {
    const customRoleId = overrides[fruitId] ?? null;
    if (!customRoleId) return null;
    // Prevent "@unknown-role" if a custom role was deleted from the server
    if (guild && guild.roles.cache.size > 0 && !guild.roles.cache.has(customRoleId)) {
      return null;
    }
    return customRoleId;
  }

  // Only apply hardcoded main-server defaults when that role actually exists in the guild
  const defaultRoleId = FRUIT_BY_ID.get(fruitId)?.specialRoleId ?? null;
  if (!defaultRoleId) return null;
  if (guild) {
    return guild.roles.cache.has(defaultRoleId) ? defaultRoleId : null;
  }
  return defaultRoleId;
}

export function setFruitPingRoleId(
  guildId: string,
  fruitId: string,
  roleId: string | null,
): void {
  if (!FRUIT_BY_ID.has(fruitId)) return;
  const current = { ...(guildStockPings.get(guildId) ?? {}) };
  current[fruitId] = roleId;
  guildStockPings.set(guildId, current);
  saveStockPings();
}

// Computes exact 6-hour UTC cycle bounds (00:00, 06:00, 12:00, 18:00 UTC)
export function getCurrentCycleBounds(nowMs = Date.now()): {
  cycleStartMs: number;
  nextRefreshMs: number;
} {
  const cycleStartMs = Math.floor(nowMs / SIX_HOURS_MS) * SIX_HOURS_MS;
  return {
    cycleStartMs,
    nextRefreshMs: cycleStartMs + SIX_HOURS_MS,
  };
}

function normalizeToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+fruit$/i, '')
    .trim();
}

// Damerau-Levenshtein distance (treats adjacent character swaps like "dragn" / "ptre" / "deomn" as distance 1)
function damerauLevenshtein(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );

  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        val = Math.min(val, dp[i - 2][j - 2] + 1);
      }
      dp[i][j] = val;
    }
  }

  return dp[n][m];
}

// Fuzzy matches user input against Legacy_Fruits (handles typos, abbreviations, and extra "fruit" suffix)
export function matchLegacyFruitFuzzy(
  rawInput: string,
  candidates: LegacyFruitEntry[] = LEGACY_FRUITS_CATALOG,
): LegacyFruitEntry | undefined {
  const q = normalizeToken(rawInput);
  if (!q) return undefined;

  for (const fruit of candidates) {
    if (fruit.id === q) return fruit;
    for (const alias of fruit.aliases) {
      if (normalizeToken(alias) === q) {
        return fruit;
      }
    }
  }

  if (q.length >= 2) {
    const prefixHits: Array<{ fruit: LegacyFruitEntry; len: number }> = [];
    for (const fruit of candidates) {
      const keys = [fruit.id, ...fruit.aliases.map(normalizeToken)];
      for (const key of keys) {
        if (key.startsWith(q)) {
          prefixHits.push({ fruit, len: key.length });
          break;
        }
      }
    }
    if (prefixHits.length > 0) {
      prefixHits.sort((a, b) => a.len - b.len);
      return prefixHits[0].fruit;
    }
  }

  const compactQ = q.replace(/\s+/g, '');
  let bestFruit: LegacyFruitEntry | undefined;
  let bestScore = 0;

  for (const fruit of candidates) {
    const keys = new Set<string>([
      fruit.id,
      ...fruit.aliases.map((a) => normalizeToken(a).replace(/\s+/g, '')),
    ]);

    for (const key of keys) {
      if (!key) continue;
      const dist = damerauLevenshtein(compactQ, key);
      const maxLen = Math.max(compactQ.length, key.length);
      const maxAllowedDist =
        key.length <= 3 ? 1 : key.length <= 5 ? 2 : Math.max(2, Math.floor(key.length * 0.4));

      if (dist > maxAllowedDist) continue;

      let score = 1 - dist / maxLen;
      if (compactQ[0] === key[0]) {
        score += 0.08;
      }
      if (key.includes(compactQ) || compactQ.includes(key)) {
        score += 0.08;
      }

      if (score >= 0.48 && score > bestScore) {
        bestScore = score;
        bestFruit = fruit;
      }
    }
  }

  return bestFruit;
}

export function parseFruitInputList(
  rawText: string,
  candidates: LegacyFruitEntry[] = LEGACY_FRUITS_CATALOG,
): { matched: LegacyFruitEntry[]; unmatched: string[] } {
  const parts = rawText
    .split(/[,\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const matched: LegacyFruitEntry[] = [];
  const unmatched: string[] = [];
  const seenIds = new Set<string>();

  for (const part of parts) {
    const hit = matchLegacyFruitFuzzy(part, candidates);
    if (hit) {
      if (!seenIds.has(hit.id)) {
        seenIds.add(hit.id);
        matched.push(hit);
      }
    } else {
      unmatched.push(part);
    }
  }

  return { matched, unmatched };
}

export function loadStockConfigs(): void {
  try {
    if (fs.existsSync(STOCK_STORE_PATH)) {
      const raw = fs.readFileSync(STOCK_STORE_PATH, 'utf8');
      if (raw.trim()) {
        const parsed = JSON.parse(raw) as
          | PersistedStockPayload
          | Array<StockChannelConfig & { cycleStartMs?: number; nextRefreshMs?: number; fruits?: string[]; revision?: number }>;

        stockStore.clear();

        if (Array.isArray(parsed)) {
          // Migrate legacy array-only schema seamlessly
          for (const entry of parsed) {
            if (!entry || !entry.channelId || !entry.guildId) continue;
            const isFirst = stockStore.size === 0;
            stockStore.set(entry.channelId, {
              guildId: entry.guildId,
              channelId: entry.channelId,
              isMain: Boolean(entry.isMain) || isFirst,
              activeMessageId: entry.activeMessageId ?? null,
              updatedAt: Number(entry.updatedAt) || Date.now(),
            });
            if (isFirst && Array.isArray(entry.fruits)) {
              globalStock.fruits = entry.fruits.filter((id) => FRUIT_BY_ID.has(id));
              globalStock.cycleStartMs = Number(entry.cycleStartMs) || globalStock.cycleStartMs;
              globalStock.nextRefreshMs = Number(entry.nextRefreshMs) || globalStock.nextRefreshMs;
              globalStock.revision = Number(entry.revision) || 0;
            }
          }
        } else if (parsed && typeof parsed === 'object') {
          if (parsed.globalStock) {
            const gs = parsed.globalStock;
            globalStock = {
              cycleStartMs: Number(gs.cycleStartMs) || globalStock.cycleStartMs,
              nextRefreshMs: Number(gs.nextRefreshMs) || globalStock.nextRefreshMs,
              fruits: Array.isArray(gs.fruits)
                ? gs.fruits.filter((id) => FRUIT_BY_ID.has(id))
                : [],
              revision: Number(gs.revision) || 0,
              updatedAt: Number(gs.updatedAt) || Date.now(),
            };
          }
          if (Array.isArray(parsed.channels)) {
            for (const entry of parsed.channels) {
              if (!entry || !entry.channelId || !entry.guildId) continue;
              stockStore.set(entry.channelId, {
                guildId: entry.guildId,
                channelId: entry.channelId,
                isMain: Boolean(entry.isMain),
                activeMessageId: entry.activeMessageId ?? null,
                updatedAt: Number(entry.updatedAt) || Date.now(),
              });
            }
          }
        }

        console.log(
          `[Stock] Loaded ${stockStore.size} stock channel config(s) from ${STOCK_STORE_PATH}.`,
        );
      }
    }
  } catch (error) {
    console.error('[Stock] Failed to load stock configs:', error);
  }

  try {
    if (!fs.existsSync(STOCK_PINGS_STORE_PATH)) return;
    const raw = fs.readFileSync(STOCK_PINGS_STORE_PATH, 'utf8');
    if (!raw.trim()) return;

    const parsed = JSON.parse(raw) as Record<string, Record<string, string | null>>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

    guildStockPings.clear();
    for (const [guildId, mapping] of Object.entries(parsed)) {
      if (!guildId || !mapping || typeof mapping !== 'object') continue;
      const cleaned: Record<string, string | null> = {};
      for (const [fruitId, roleId] of Object.entries(mapping)) {
        if (!FRUIT_BY_ID.has(fruitId)) continue;
        cleaned[fruitId] = typeof roleId === 'string' && roleId.trim() ? roleId.trim() : null;
      }
      guildStockPings.set(guildId, cleaned);
    }
    console.log(
      `[Stock] Loaded custom stock pings for ${guildStockPings.size} guild(s).`,
    );
  } catch (error) {
    console.error('[Stock] Failed to load stock pings:', error);
  }

  try {
    if (!fs.existsSync(STOCK_EMOJIS_STORE_PATH)) return;
    const raw = fs.readFileSync(STOCK_EMOJIS_STORE_PATH, 'utf8');
    if (!raw.trim()) return;

    const parsed = JSON.parse(raw) as Record<string, string>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

    dynamicFruitEmojis.clear();
    for (const [fruitId, emojiTag] of Object.entries(parsed)) {
      if (!FRUIT_BY_ID.has(fruitId)) continue;
      if (typeof emojiTag === 'string' && /^<a?:[a-zA-Z0-9_]+:\d+>$/.test(emojiTag.trim())) {
        dynamicFruitEmojis.set(fruitId, emojiTag.trim());
      }
    }
    if (dynamicFruitEmojis.size > 0) {
      console.log(
        `[Stock] Loaded ${dynamicFruitEmojis.size} uploaded fruit emoji(s).`,
      );
    }
  } catch (error) {
    console.error('[Stock] Failed to load cached stock emojis:', error);
  }
}

function saveStockConfigs(): void {
  try {
    const dir = path.dirname(STOCK_STORE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const payload: PersistedStockPayload = {
      globalStock,
      channels: Array.from(stockStore.values()),
    };
    const tmpPath = `${STOCK_STORE_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmpPath, STOCK_STORE_PATH);
  } catch (error) {
    console.error('[Stock] Failed to save stock configs:', error);
  }
}

function saveStockPings(): void {
  try {
    const dir = path.dirname(STOCK_PINGS_STORE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const obj: Record<string, Record<string, string | null>> = {};
    for (const [guildId, mapping] of guildStockPings.entries()) {
      obj[guildId] = mapping;
    }
    const tmpPath = `${STOCK_PINGS_STORE_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmpPath, STOCK_PINGS_STORE_PATH);
  } catch (error) {
    console.error('[Stock] Failed to save stock pings:', error);
  }
}

function saveStockEmojis(): void {
  try {
    const dir = path.dirname(STOCK_EMOJIS_STORE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const obj: Record<string, string> = {};
    for (const [fruitId, emojiTag] of dynamicFruitEmojis.entries()) {
      obj[fruitId] = emojiTag;
    }
    const tmpPath = `${STOCK_EMOJIS_STORE_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmpPath, STOCK_EMOJIS_STORE_PATH);
  } catch (error) {
    console.error('[Stock] Failed to save stock emojis:', error);
  }
}

function resolveFruitAssetPath(fruitId: string): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'src/bot/assets/fruits', `${fruitId}.png`),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'assets/fruits', `${fruitId}.png`),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// Uploads any missing fruit PNGs from src/bot/assets/fruits/ to Discord Application Emojis
export async function syncMissingFruitEmojis(client: Client): Promise<void> {
  if (emojiSyncPromise) return emojiSyncPromise;

  emojiSyncPromise = (async () => {
    if (!client.isReady() || !client.application || isSupersededLocally()) return;

    try {
      const existing = await client.application.emojis.fetch();
      const byNameLower = new Map<string, ApplicationEmoji>();
      for (const emoji of existing.values()) {
        if (emoji.name) {
          byNameLower.set(emoji.name.toLowerCase(), emoji);
        }
      }

      let boundAny = false;
      let uploadedCount = 0;

      for (const fruit of LEGACY_FRUITS_CATALOG) {
        if (fruit.emoji) continue;

        const targetName = `fruit_${fruit.id}`;
        const existingEmoji =
          byNameLower.get(targetName.toLowerCase()) ??
          byNameLower.get(fruit.id.toLowerCase());

        if (existingEmoji) {
          const tag = `<${existingEmoji.animated ? 'a' : ''}:${existingEmoji.name}:${existingEmoji.id}>`;
          if (dynamicFruitEmojis.get(fruit.id) !== tag) {
            dynamicFruitEmojis.set(fruit.id, tag);
            boundAny = true;
          }
          continue;
        }

        const assetPath = resolveFruitAssetPath(fruit.id);
        if (!assetPath) {
          console.warn(`[Stock] Missing local PNG asset for fruit "${fruit.id}".`);
          continue;
        }

        try {
          const buffer = fs.readFileSync(assetPath);
          const created = await client.application.emojis.create({
            attachment: buffer,
            name: targetName,
          });
          const tag = `<${created.animated ? 'a' : ''}:${created.name}:${created.id}>`;
          dynamicFruitEmojis.set(fruit.id, tag);
          byNameLower.set(targetName.toLowerCase(), created);
          boundAny = true;
          uploadedCount++;
        } catch (err) {
          console.warn(
            `[Stock] Could not upload application emoji "${targetName}":`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      if (boundAny) {
        saveStockEmojis();
      }
      if (uploadedCount > 0) {
        console.log(`[Stock] Uploaded ${uploadedCount} missing fruit emoji(s) to Discord.`);
      }

      // Refresh any populated active stock embeds so newly bound emojis show immediately
      if (boundAny && globalStock.fruits.length > 0 && stockStore.size > 0) {
        for (const config of stockStore.values()) {
          if (config.activeMessageId) {
            await syncSingleChannelMessage(client, config);
          }
        }
      }
    } catch (error) {
      console.warn(
        '[Stock] Could not sync missing application emojis:',
        error instanceof Error ? error.message : String(error),
      );
    }
  })().finally(() => {
    emojiSyncPromise = null;
  });

  return emojiSyncPromise;
}

function buildStockSelectMenu(
  channelConfig: StockChannelConfig,
  stockState: GlobalStockState,
  expired = false,
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const hasFruits = stockState.fruits.length > 0;
  const options: StringSelectMenuOptionBuilder[] = [
    new StringSelectMenuOptionBuilder()
      .setLabel('add fruits')
      .setValue('add')
      .setEmoji(PLUS_EMOJI),
  ];

  if (hasFruits) {
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel('remove fruits')
        .setValue('remove')
        .setEmoji(MINUS_EMOJI),
    );
  } else {
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel('...')
        .setValue('noop'),
    );
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(
      `stk_menu:${channelConfig.channelId}:${stockState.cycleStartMs}:${stockState.revision}`,
    )
    .setPlaceholder('select an option')
    .setDisabled(expired)
    .addOptions(options);

  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu);
}

export function buildStockMessagePayload(
  channelConfig: StockChannelConfig,
  stockState: GlobalStockState = globalStock,
  options?: { expired?: boolean; guild?: Guild | null; mainInputRoleExists?: boolean },
): MessageCreateOptions & MessageEditOptions {
  const expired = Boolean(options?.expired);
  const fruits = stockState.fruits
    .map((id) => FRUIT_BY_ID.get(id))
    .filter((f): f is LegacyFruitEntry => Boolean(f));

  const topComponents: Array<
    TextDisplayBuilder | ContainerBuilder | ActionRowBuilder<MessageActionRowComponentBuilder>
  > = [];

  const marker = channelConfig.isMain ? STOCK_MARKER_MAIN : STOCK_MARKER_FOLLOWER;

  if (fruits.length === 0) {
    const refreshLine = `### ${REFRESH_EMOJI} Stock has been refreshed!`;
    const canShowMainRolePrompt =
      channelConfig.isMain &&
      (options?.mainInputRoleExists ??
        (options?.guild ? options.guild.roles.cache.has(MAIN_INPUT_ROLE_ID) : true));

    const promptLine = canShowMainRolePrompt
      ? `\n-# <@&${MAIN_INPUT_ROLE_ID}> please input the stock`
      : '';

    topComponents.push(
      new TextDisplayBuilder().setContent(`${refreshLine}${promptLine}${marker}`),
    );

    if (channelConfig.isMain) {
      topComponents.push(buildStockSelectMenu(channelConfig, stockState, expired));
    }

    if (expired) {
      topComponents.push(new TextDisplayBuilder().setContent('-# expired'));
    }

    return {
      flags: MessageFlags.IsComponentsV2,
      components: topComponents,
      allowedMentions: {
        parse: [],
        users: [],
        roles: canShowMainRolePrompt ? [MAIN_INPUT_ROLE_ID] : [],
      },
    };
  }

  // Collect unique configured role IDs for this specific server
  const activePingRoleIds: string[] = [];
  for (const fruit of fruits) {
    const roleId = getEffectiveFruitPingRoleId(
      channelConfig.guildId,
      fruit.id,
      options?.guild,
    );
    if (roleId && !activePingRoleIds.includes(roleId)) {
      activePingRoleIds.push(roleId);
    }
  }

  if (activePingRoleIds.length > 0) {
    topComponents.push(
      new TextDisplayBuilder().setContent(
        activePingRoleIds.map((roleId) => `<@&${roleId}>`).join(' '),
      ),
    );
  }

  const fruitLines = fruits.map((fruit) => {
    const resolvedEmoji = getFruitEmoji(fruit);
    const emojiPart = resolvedEmoji ? `${resolvedEmoji} ` : '';
    return `${emojiPart}**${fruit.name}** • ${MONEY_EMOJI} \`${fruit.price}\``;
  });

  const nextRefreshUnix = Math.floor(stockState.nextRefreshMs / 1000);
  const container = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## current stock\n${fruitLines.join('\n')}`),
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# new stock - <t:${nextRefreshUnix}:R>${marker}`),
    );

  // Only the bot owner's main embed includes the interactive stock input dropdown
  if (channelConfig.isMain) {
    container.addActionRowComponents(
      buildStockSelectMenu(channelConfig, stockState, expired),
    );
  }

  if (expired && channelConfig.isMain) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('-# expired'),
    );
  }

  topComponents.push(container);

  return {
    flags: MessageFlags.IsComponentsV2,
    components: topComponents,
    allowedMentions: {
      parse: [],
      roles: activePingRoleIds,
    },
  };
}

async function resolveSendableChannel(
  client: Client,
  channelId: string,
): Promise<GuildTextBasedChannel | null> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;
  if (!('send' in channel)) return null;

  const guildChannel = channel as GuildTextBasedChannel;
  const me =
    guildChannel.guild.members.me ??
    (await guildChannel.guild.members.fetchMe().catch(() => null));
  if (!me) return null;

  const perms = guildChannel.permissionsFor(me);
  const canSend = guildChannel.isThread()
    ? perms?.has(PermissionsBitField.Flags.SendMessagesInThreads)
    : perms?.has(PermissionsBitField.Flags.SendMessages);
  if (!perms?.has(PermissionsBitField.Flags.ViewChannel) || !canSend) {
    return null;
  }

  return guildChannel;
}

async function buildPayloadForChannel(
  client: Client,
  config: StockChannelConfig,
  expired = false,
): Promise<{
  channel: GuildTextBasedChannel | null;
  payload: MessageCreateOptions & MessageEditOptions;
}> {
  const channel = await resolveSendableChannel(client, config.channelId);
  const guild = channel?.guild ?? (await client.guilds.fetch(config.guildId).catch(() => null));

  let mainInputRoleExists = false;
  if (config.isMain && guild) {
    mainInputRoleExists =
      guild.roles.cache.has(MAIN_INPUT_ROLE_ID) ||
      Boolean(await guild.roles.fetch(MAIN_INPUT_ROLE_ID).catch(() => null));
  }

  return {
    channel,
    payload: buildStockMessagePayload(config, globalStock, {
      expired,
      guild,
      mainInputRoleExists,
    }),
  };
}

function serializeComponentNode(node: unknown): Record<string, unknown> {
  const raw =
    node &&
    typeof node === 'object' &&
    'toJSON' in node &&
    typeof (node as { toJSON?: () => unknown }).toJSON === 'function'
      ? ((node as { toJSON: () => unknown }).toJSON() as Record<string, unknown>)
      : (node as Record<string, unknown>);
  return JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
}

// Builds an expired edit payload from the message's own components so old stock embeds stay intact
export function buildExpiredPayloadFromMessage(message: {
  components?: unknown[];
}): MessageEditOptions | null {
  const rawComponents = Array.isArray(message.components) ? message.components : [];
  if (rawComponents.length === 0) return null;

  const cloned = rawComponents.map((comp) => serializeComponentNode(comp));
  let hasExpiredFooter = false;

  const walkAndFreeze = (node: Record<string, unknown>): void => {
    const type = typeof node.type === 'number' ? node.type : undefined;

    if (typeof node.content === 'string') {
      if (node.content.replace(STOCK_MARKER_REGEX, '').trim() === '-# expired') {
        hasExpiredFooter = true;
      }
    }

    const customId =
      typeof node.custom_id === 'string'
        ? node.custom_id
        : typeof node.customId === 'string'
          ? node.customId
          : null;
    if (
      customId &&
      customId.startsWith('stk_menu:') &&
      (type === undefined || type === ComponentType.StringSelect)
    ) {
      node.disabled = true;
    }

    if (Array.isArray(node.components)) {
      for (const child of node.components) {
        if (child && typeof child === 'object') {
          walkAndFreeze(child as Record<string, unknown>);
        }
      }
    }
  };

  for (const node of cloned) {
    walkAndFreeze(node);
  }

  if (!hasExpiredFooter) {
    const expiredText = {
      type: ComponentType.TextDisplay,
      content: '-# expired',
    };
    const containerNode = cloned.find(
      (n) => n.type === ComponentType.Container && Array.isArray(n.components),
    );
    if (containerNode && Array.isArray(containerNode.components)) {
      containerNode.components.push(expiredText);
    } else {
      cloned.push(expiredText);
    }
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components: cloned as unknown as MessageEditOptions['components'],
    allowedMentions: { parse: [], roles: [], users: [] },
  };
}

async function expireStockMessageIfPresent(
  client: Client,
  config: StockChannelConfig,
): Promise<void> {
  if (!config.activeMessageId) return;
  const channel = await resolveSendableChannel(client, config.channelId);
  if (!channel) return;

  try {
    const msg = await channel.messages.fetch(config.activeMessageId).catch(() => null);
    if (!msg || !msg.editable) return;

    const payload = buildExpiredPayloadFromMessage(msg);
    if (!payload) return;

    await msg.edit(payload);
  } catch (error) {
    console.warn(
      `[Stock] Could not expire previous stock message ${config.activeMessageId}:`,
      error,
    );
  }
}

// Adds <:Win:...> and <:loss:...> reactions when fruits are set, or clears bot's own vote reactions if stock is emptied
export async function syncStockMessageReactions(
  message: Message | null | undefined,
  hasFruits = globalStock.fruits.length > 0,
): Promise<void> {
  if (!message) return;

  if (message.inGuild()) {
    const me =
      message.guild.members.me ??
      (await message.guild.members.fetchMe().catch(() => null));
    const perms = me ? message.channel.permissionsFor(me) : null;
    if (perms && !perms.has(PermissionsBitField.Flags.AddReactions)) {
      return;
    }
  }

  if (hasFruits) {
    for (const emojiTag of STOCK_VOTE_REACTIONS) {
      const parsed = parseDiscordEmoji(emojiTag);
      const existing = parsed ? message.reactions.cache.get(parsed.id) : undefined;
      if (existing?.me) continue;

      try {
        await message.react(emojiTag);
      } catch (error) {
        console.warn(
          `[Stock] Could not add reaction ${emojiTag} on message ${message.id}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return;
  }

  // If all fruits were removed back to 0, remove the bot's own vote reactions if present
  const botId = message.client.user?.id;
  if (!botId) return;
  for (const emojiTag of STOCK_VOTE_REACTIONS) {
    const parsed = parseDiscordEmoji(emojiTag);
    const existing = parsed ? message.reactions.cache.get(parsed.id) : undefined;
    if (existing?.me) {
      await existing.users.remove(botId).catch(() => null);
    }
  }
}

async function postFreshStockMessage(
  client: Client,
  config: StockChannelConfig,
): Promise<Message | null> {
  const { channel, payload } = await buildPayloadForChannel(client, config, false);
  if (!channel) return null;

  const sent = await channel.send(payload);
  config.activeMessageId = sent.id;
  config.updatedAt = Date.now();
  saveStockConfigs();
  if (globalStock.fruits.length > 0) {
    void syncStockMessageReactions(sent, true);
  }
  return sent;
}

async function syncSingleChannelMessage(
  client: Client,
  config: StockChannelConfig,
): Promise<void> {
  if (inFlightChannelUpdates.has(config.channelId)) return;
  inFlightChannelUpdates.add(config.channelId);

  try {
    const { channel, payload } = await buildPayloadForChannel(client, config, false);
    if (!channel) return;

    if (config.activeMessageId) {
      const msg = await channel.messages.fetch(config.activeMessageId).catch(() => null);
      if (msg && msg.editable) {
        await msg.edit(payload);
        config.updatedAt = Date.now();
        saveStockConfigs();
        void syncStockMessageReactions(msg, globalStock.fruits.length > 0);
        return;
      }
    }

    const sent = await channel.send(payload);
    config.activeMessageId = sent.id;
    config.updatedAt = Date.now();
    saveStockConfigs();
    void syncStockMessageReactions(sent, globalStock.fruits.length > 0);
  } catch (error) {
    console.error(`[Stock] Failed to sync stock message in channel ${config.channelId}:`, error);
  } finally {
    inFlightChannelUpdates.delete(config.channelId);
  }
}

async function syncAllFollowerStockMessages(client: Client): Promise<void> {
  for (const config of stockStore.values()) {
    if (config.isMain) continue;
    await syncSingleChannelMessage(client, config);
  }
}

export interface ExtractedStockMessage {
  messageId: string;
  channelId: string;
  guildId: string;
  isMain: boolean;
  cycleStartMs: number;
  nextRefreshMs: number;
  fruits: string[];
  createdTimestamp: number;
}

function collectComponentsInfo(rawComponents: unknown[]): {
  texts: string[];
  selectMenus: Array<{ customId: string; disabled: boolean }>;
} {
  const texts: string[] = [];
  const selectMenus: Array<{ customId: string; disabled: boolean }> = [];

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const obj =
      'toJSON' in node && typeof (node as { toJSON?: () => unknown }).toJSON === 'function'
        ? ((node as { toJSON: () => unknown }).toJSON() as Record<string, unknown>)
        : (node as Record<string, unknown>);

    const type = typeof obj.type === 'number' ? obj.type : undefined;
    if (type === ComponentType.TextDisplay && typeof obj.content === 'string') {
      texts.push(obj.content);
    } else if (typeof obj.content === 'string' && !Array.isArray(obj.components)) {
      texts.push(obj.content);
    }

    const customId =
      typeof obj.custom_id === 'string'
        ? obj.custom_id
        : typeof obj.customId === 'string'
          ? obj.customId
          : null;
    if (
      customId &&
      customId.startsWith('stk_menu:') &&
      (type === undefined || type === ComponentType.StringSelect)
    ) {
      selectMenus.push({
        customId,
        disabled: Boolean(obj.disabled),
      });
    }

    if (Array.isArray(obj.components)) {
      for (const child of obj.components) {
        visit(child);
      }
    }
  };

  for (const item of rawComponents) {
    visit(item);
  }

  return { texts, selectMenus };
}

// Extracts stock state and channel role (main vs follower) from a live Components V2 message
export function extractStockStateFromMessage(
  message: {
    id?: string;
    channelId?: string;
    guildId?: string | null;
    author?: { id?: string } | null;
    createdTimestamp?: number;
    components?: unknown[];
  },
  botId?: string,
): ExtractedStockMessage | null {
  if (botId && message.author?.id && message.author.id !== botId) {
    return null;
  }

  const rawComponents = Array.isArray(message.components) ? message.components : [];
  if (rawComponents.length === 0) return null;

  const { texts, selectMenus } = collectComponentsInfo(rawComponents);
  const fullText = texts.join('\n');

  const hasMarkerMain = fullText.includes(STOCK_MARKER_MAIN);
  const hasMarkerFollower = fullText.includes(STOCK_MARKER_FOLLOWER);
  const hasStockMenu = selectMenus.length > 0;
  const hasRefreshHeader = fullText.includes('Stock has been refreshed!');
  const hasStockHeader =
    fullText.includes('## current stock') && fullText.includes('-# new stock - <t:');

  if (!hasMarkerMain && !hasMarkerFollower && !hasStockMenu && !hasRefreshHeader && !hasStockHeader) {
    return null;
  }

  const isMarkedExpired =
    texts.some((t) => t.replace(STOCK_MARKER_REGEX, '').trim() === '-# expired') ||
    (selectMenus.length > 0 && selectMenus.every((m) => m.disabled));
  if (isMarkedExpired) {
    return null;
  }

  const isMain =
    hasStockMenu || hasMarkerMain || fullText.includes('please input the stock');

  let cycleStartMs: number | null = null;
  if (selectMenus.length > 0) {
    const parts = selectMenus[0].customId.split(':');
    const parsed = Number(parts[2]);
    if (Number.isFinite(parsed) && parsed > 0) {
      cycleStartMs = parsed;
    }
  }

  if (cycleStartMs === null) {
    const tsMatch = fullText.match(/-# new stock - <t:(\d+):R>/);
    if (tsMatch) {
      const nextRefreshMs = Number(tsMatch[1]) * 1000;
      if (Number.isFinite(nextRefreshMs) && nextRefreshMs > SIX_HOURS_MS) {
        cycleStartMs = nextRefreshMs - SIX_HOURS_MS;
      }
    }
  }

  const createdTimestamp = Number(message.createdTimestamp) || Date.now();
  if (cycleStartMs === null) {
    cycleStartMs = getCurrentCycleBounds(createdTimestamp).cycleStartMs;
  }

  const fruits: string[] = [];
  const seenFruitIds = new Set<string>();
  const stockSection = texts.find((t) => t.includes('## current stock'));
  if (stockSection) {
    for (const rawLine of stockSection.split('\n')) {
      const cleanLine = rawLine.replace(STOCK_MARKER_REGEX, '').trim();
      const match = cleanLine.match(/^(?:<a?:[a-zA-Z0-9_]+:\d+>\s*)?\*\*(.+?)\*\*\s*•/);
      if (!match) continue;
      const fruitName = match[1].trim();
      const fruit =
        FRUIT_BY_NAME_LOWER.get(fruitName.toLowerCase()) ??
        matchLegacyFruitFuzzy(fruitName);
      if (fruit && !seenFruitIds.has(fruit.id)) {
        seenFruitIds.add(fruit.id);
        fruits.push(fruit.id);
      }
    }
  }

  return {
    messageId: message.id ?? '',
    channelId: message.channelId ?? '',
    guildId: message.guildId ?? '',
    isMain,
    cycleStartMs,
    nextRefreshMs: cycleStartMs + SIX_HOURS_MS,
    fruits,
    createdTimestamp,
  };
}

async function adoptOrEnsureChannelStockMessage(
  client: Client,
  config: StockChannelConfig,
): Promise<void> {
  if (inFlightChannelUpdates.has(config.channelId)) return;
  inFlightChannelUpdates.add(config.channelId);

  try {
    const channel = await resolveSendableChannel(client, config.channelId);
    if (!channel) return;

    if (config.activeMessageId) {
      const existing = await channel.messages.fetch(config.activeMessageId).catch(() => null);
      if (existing) {
        const extracted = extractStockStateFromMessage(existing, client.user?.id);
        // Never expire an active in-cycle embed after restart
        if (extracted && extracted.cycleStartMs === globalStock.cycleStartMs) {
          if (config.isMain && globalStock.fruits.length === 0 && extracted.fruits.length > 0) {
            globalStock.fruits = [...extracted.fruits];
            globalStock.updatedAt = Date.now();
            saveStockConfigs();
          }
          if (extracted.fruits.length > 0 || globalStock.fruits.length > 0) {
            void syncStockMessageReactions(existing, true);
          }
          return;
        }
      }
    }

    // Look for an active un-expired stock message already in recent history before posting a duplicate
    const recent = await channel.messages.fetch({ limit: RECOVERY_MESSAGES_LIMIT }).catch(() => null);
    if (recent) {
      const botId = client.user?.id;
      const ordered = [...recent.values()].sort(
        (a, b) => b.createdTimestamp - a.createdTimestamp,
      );
      for (const msg of ordered) {
        const extracted = extractStockStateFromMessage(msg, botId);
        if (extracted && extracted.cycleStartMs === globalStock.cycleStartMs) {
          config.activeMessageId = msg.id;
          config.updatedAt = Date.now();
          if (config.isMain && globalStock.fruits.length === 0 && extracted.fruits.length > 0) {
            globalStock.fruits = [...extracted.fruits];
            globalStock.updatedAt = Date.now();
          }
          saveStockConfigs();
          if (extracted.fruits.length > 0 || globalStock.fruits.length > 0) {
            void syncStockMessageReactions(msg, true);
          }
          return;
        }
      }
    }

    await postFreshStockMessage(client, config);
  } catch (error) {
    console.warn(
      `[Stock] Could not verify active stock message in channel ${config.channelId}:`,
      error,
    );
  } finally {
    inFlightChannelUpdates.delete(config.channelId);
  }
}

// Recovers configured stock channels and active cycle state from Discord if ephemeral disk state was wiped
export async function reconcileStockChannels(
  client: Client,
  targetGuildId?: string,
): Promise<void> {
  if (reconcilePromise) return reconcilePromise;

  reconcilePromise = (async () => {
    if (!client.isReady() || isSupersededLocally()) return;
    const botId = client.user?.id;
    if (!botId) return;

    const needsColdScan =
      stockStore.size === 0 ||
      Boolean(
        targetGuildId &&
          !Array.from(stockStore.values()).some((c) => c.guildId === targetGuildId),
      );

    if (needsColdScan) {
      const guilds = targetGuildId
        ? [client.guilds.cache.get(targetGuildId)].filter((g): g is Guild => Boolean(g))
        : [...client.guilds.cache.values()];

      const candidateChannels: GuildTextBasedChannel[] = [];
      for (const guild of guilds) {
        const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
        if (!me) continue;

        for (const ch of guild.channels.cache.values()) {
          if (!ch.isTextBased() || ch.isDMBased() || !('messages' in ch)) continue;
          const guildCh = ch as GuildTextBasedChannel;
          const perms = guildCh.permissionsFor(me);
          const canSend = guildCh.isThread()
            ? perms?.has(PermissionsBitField.Flags.SendMessagesInThreads)
            : perms?.has(PermissionsBitField.Flags.SendMessages);
          if (
            !perms?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory]) ||
            !canSend
          ) {
            continue;
          }
          candidateChannels.push(guildCh);
        }
      }

      // Prioritize channels whose name looks stock-related so recovery finishes quickly
      const stockNameRegex = /stock|market|fruit|bot|update|notif|alert|ping/i;
      candidateChannels.sort((a, b) => {
        const aScore = stockNameRegex.test(a.name) ? 0 : 1;
        const bScore = stockNameRegex.test(b.name) ? 0 : 1;
        return aScore - bScore;
      });

      const currentBounds = getCurrentCycleBounds();
      const recoveredMessages: ExtractedStockMessage[] = [];

      for (let i = 0; i < candidateChannels.length; i += RECOVERY_SCAN_BATCH_SIZE) {
        if (isSupersededLocally()) return;
        const batch = candidateChannels.slice(i, i + RECOVERY_SCAN_BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(async (channel) => {
            try {
              const recent = await channel.messages
                .fetch({ limit: RECOVERY_MESSAGES_LIMIT })
                .catch(() => null);
              if (!recent) return null;

              const ordered = [...recent.values()].sort(
                (a, b) => b.createdTimestamp - a.createdTimestamp,
              );
              for (const msg of ordered) {
                const extracted = extractStockStateFromMessage(msg, botId);
                if (extracted) {
                  return extracted;
                }
              }
              return null;
            } catch {
              return null;
            }
          }),
        );

        for (const res of batchResults) {
          if (res && res.channelId && res.guildId) {
            recoveredMessages.push(res);
          }
        }
      }

      if (recoveredMessages.length > 0) {
        let restoredCount = 0;
        let hasMainInStore = Array.from(stockStore.values()).some((c) => c.isMain);

        for (const rec of recoveredMessages) {
          if (stockStore.has(rec.channelId)) continue;
          const isMain = rec.isMain && !hasMainInStore;
          if (isMain) hasMainInStore = true;

          stockStore.set(rec.channelId, {
            guildId: rec.guildId,
            channelId: rec.channelId,
            isMain,
            activeMessageId: rec.messageId || null,
            updatedAt: rec.createdTimestamp || Date.now(),
          });
          restoredCount++;
        }

        // Restore active current-cycle fruits & timestamps without marking current embed expired
        const currentCycleRecovered = recoveredMessages.filter(
          (r) => r.cycleStartMs === currentBounds.cycleStartMs,
        );
        if (currentCycleRecovered.length > 0) {
          currentCycleRecovered.sort((a, b) => {
            if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
            return b.fruits.length - a.fruits.length;
          });
          const best = currentCycleRecovered[0];
          globalStock.cycleStartMs = currentBounds.cycleStartMs;
          globalStock.nextRefreshMs = currentBounds.nextRefreshMs;
          if (globalStock.fruits.length === 0 && best.fruits.length > 0) {
            globalStock.fruits = [...best.fruits];
          }
          globalStock.updatedAt = Date.now();
        } else {
          // Recovered channel was from an older cycle whose rollover occurred while offline
          const latestOld = recoveredMessages.reduce((a, b) =>
            a.cycleStartMs > b.cycleStartMs ? a : b,
          );
          if (latestOld.cycleStartMs < globalStock.cycleStartMs && Date.now() >= latestOld.nextRefreshMs) {
            globalStock.cycleStartMs = latestOld.cycleStartMs;
            globalStock.nextRefreshMs = latestOld.nextRefreshMs;
          }
        }

        if (restoredCount > 0) {
          saveStockConfigs();
          console.log(
            `[Stock] Cold-recovered ${restoredCount} stock channel(s) from Discord history.`,
          );
        }
      }
    }

    // If still within the active 6-hour cycle, ensure every configured channel has its live un-expired embed
    if (stockStore.size > 0 && Date.now() < globalStock.nextRefreshMs) {
      for (const config of stockStore.values()) {
        if (targetGuildId && config.guildId !== targetGuildId) continue;
        await adoptOrEnsureChannelStockMessage(client, config);
      }
    }
  })().finally(() => {
    reconcilePromise = null;
  });

  return reconcilePromise;
}

async function rollOverAllStockChannels(client: Client): Promise<void> {
  // First expire any main channel message from the ending cycle
  for (const config of stockStore.values()) {
    if (config.isMain) {
      await expireStockMessageIfPresent(client, config);
    }
  }

  const bounds = getCurrentCycleBounds();
  globalStock = {
    cycleStartMs: bounds.cycleStartMs,
    nextRefreshMs: bounds.nextRefreshMs,
    fruits: [],
    revision: globalStock.revision + 1,
    updatedAt: Date.now(),
  };

  for (const config of stockStore.values()) {
    config.activeMessageId = null;
    config.updatedAt = Date.now();
  }
  saveStockConfigs();

  // Post fresh refreshed messages in main and all follower channels
  for (const config of stockStore.values()) {
    if (inFlightChannelUpdates.has(config.channelId)) continue;
    inFlightChannelUpdates.add(config.channelId);
    try {
      await postFreshStockMessage(client, config);
    } catch (error) {
      console.error(`[Stock] Failed to post refresh in channel ${config.channelId}:`, error);
    } finally {
      inFlightChannelUpdates.delete(config.channelId);
    }
  }
}

async function checkAndRollOverAll(client: Client): Promise<void> {
  if (rolloverRunning || isSupersededLocally() || !client.isReady()) return;
  rolloverRunning = true;

  try {
    if (stockStore.size > 0 && Date.now() >= globalStock.nextRefreshMs) {
      await rollOverAllStockChannels(client);
    } else if (Date.now() >= globalStock.nextRefreshMs) {
      const bounds = getCurrentCycleBounds();
      globalStock.cycleStartMs = bounds.cycleStartMs;
      globalStock.nextRefreshMs = bounds.nextRefreshMs;
    }
  } finally {
    rolloverRunning = false;
    armNextCycleTimer(client);
  }
}

function armNextCycleTimer(client: Client): void {
  if (nextCycleTimer) {
    clearTimeout(nextCycleTimer);
    nextCycleTimer = null;
  }

  if (stockStore.size === 0) return;

  const now = Date.now();
  const targetMs =
    globalStock.nextRefreshMs > now
      ? globalStock.nextRefreshMs
      : getCurrentCycleBounds(now).nextRefreshMs;

  const delayMs = Math.max(1000, targetMs - now + 750);
  nextCycleTimer = setTimeout(() => {
    void checkAndRollOverAll(client);
  }, delayMs);
  nextCycleTimer.unref?.();
}

function ensureStockWatchdog(client: Client): void {
  armNextCycleTimer(client);

  if (!watchdogInterval) {
    watchdogInterval = setInterval(() => {
      void checkAndRollOverAll(client);
    }, WATCHDOG_INTERVAL_MS);
    watchdogInterval.unref?.();
  }
}

export async function initStockSchedules(client: Client): Promise<void> {
  await reconcileStockChannels(client);
  await checkAndRollOverAll(client);
  ensureStockWatchdog(client);
}

function memberHasRole(
  interaction: StringSelectMenuInteraction | ModalSubmitInteraction,
  requiredRoleId: string,
): boolean {
  const roles = interaction.member?.roles;
  if (!roles) return false;
  if (Array.isArray(roles)) {
    return roles.includes(requiredRoleId);
  }
  return (roles as GuildMemberRoleManager).cache.has(requiredRoleId);
}

async function ensureMainStockInputPermission(
  interaction: StringSelectMenuInteraction | ModalSubmitInteraction,
): Promise<boolean> {
  if (interaction.user.id === BOT_OWNER_ID) return true;
  if (memberHasRole(interaction, MAIN_INPUT_ROLE_ID)) return true;

  if (interaction.guild) {
    const member = await interaction.guild.members
      .fetch(interaction.user.id)
      .catch(() => null);
    if (member?.roles.cache.has(MAIN_INPUT_ROLE_ID)) {
      return true;
    }
  }

  await interaction.reply({
    content: `Only members with <@&${MAIN_INPUT_ROLE_ID}> can modify the stock.`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [], roles: [], users: [] },
  });
  return false;
}

function isGuildOwnerOrBotOwner(interaction: {
  user: { id: string };
  guild: { ownerId: string } | null;
}): boolean {
  if (interaction.user.id === BOT_OWNER_ID) return true;
  return Boolean(interaction.guild && interaction.guild.ownerId === interaction.user.id);
}

// Handles /stockset for bot owner (main interactive embed) and server owners (synced follower embeds)
export async function handleStockSetCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.channel || !interaction.guild) {
    await interaction.reply({
      content: 'Run `/stockset` inside the server channel where you want stock reminders.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isGuildOwnerOrBotOwner(interaction)) {
    await interaction.reply({
      content: 'Only the server owner can use `/stockset`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = await resolveSendableChannel(interaction.client, interaction.channelId);
  if (!channel) {
    await interaction.reply({
      content: 'I need permission to view and send messages in this channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Check if this channel already has stock reminders enabled; running /stockset again removes it
  let existingInChannel = stockStore.get(interaction.channelId);
  if (!existingInChannel && interaction.client.user?.id) {
    const recent = await channel.messages.fetch({ limit: 15 }).catch(() => null);
    if (recent) {
      const botId = interaction.client.user.id;
      const ordered = [...recent.values()].sort(
        (a, b) => b.createdTimestamp - a.createdTimestamp,
      );
      for (const msg of ordered) {
        const extracted = extractStockStateFromMessage(msg, botId);
        if (extracted) {
          existingInChannel = {
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            isMain: extracted.isMain,
            activeMessageId: msg.id,
            updatedAt: extracted.createdTimestamp,
          };
          break;
        }
      }
    }
  }

  if (existingInChannel) {
    stockStore.delete(interaction.channelId);
    saveStockConfigs();
    armNextCycleTimer(interaction.client);

    // Delete the active stock message so it's removed cleanly and won't be re-recovered on restart
    let removedActiveMsg = false;
    if (existingInChannel.activeMessageId) {
      const activeMsg = await channel.messages
        .fetch(existingInChannel.activeMessageId)
        .catch(() => null);
      if (activeMsg) {
        removedActiveMsg = await activeMsg
          .delete()
          .then(() => true)
          .catch(() => false);
      }
    }
    if (!removedActiveMsg) {
      await expireStockMessageIfPresent(interaction.client, existingInChannel);
    }

    await interaction.editReply({
      content: `Stock reminders removed from <#${interaction.channelId}>.`,
    });
    return;
  }

  const isMain = interaction.user.id === BOT_OWNER_ID;

  // Sync cycle bounds if stale before posting
  if (Date.now() >= globalStock.nextRefreshMs) {
    const bounds = getCurrentCycleBounds();
    globalStock = {
      cycleStartMs: bounds.cycleStartMs,
      nextRefreshMs: bounds.nextRefreshMs,
      fruits: [],
      revision: globalStock.revision + 1,
      updatedAt: Date.now(),
    };
  }

  // If setting a new main channel, expire any old main channel's dropdown in another channel
  if (isMain) {
    for (const prev of stockStore.values()) {
      if (prev.isMain) {
        await expireStockMessageIfPresent(interaction.client, prev);
        prev.isMain = false;
      }
    }
  }

  const config: StockChannelConfig = {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    isMain,
    activeMessageId: null,
    updatedAt: Date.now(),
  };

  stockStore.set(config.channelId, config);
  saveStockConfigs();

  const posted = await postFreshStockMessage(interaction.client, config);
  ensureStockWatchdog(interaction.client);

  if (!posted) {
    await interaction.editReply({
      content: 'Failed to post the initial stock message in this channel.',
    });
    return;
  }

  const nextUnix = Math.floor(globalStock.nextRefreshMs / 1000);
  const modeNote = isMain
    ? 'This is the main stock embed; updates here sync to all other servers.'
    : 'This channel will automatically mirror updates from the main stock.';

  await interaction.editReply({
    content: `Stock reminders set in <#${config.channelId}>. ${modeNote}\nNext refresh: <t:${nextUnix}:R>`,
  });
}

// Validates or cold-recovers an active main stock embed so bot restarts never prematurely expire it
function resolveActiveMainInteraction(
  interaction: StringSelectMenuInteraction | ModalSubmitInteraction,
  channelId: string,
  cycleStartMs: number,
): StockChannelConfig | null {
  if (!Number.isFinite(cycleStartMs) || cycleStartMs <= 0) return null;

  const cycleEndMs = cycleStartMs + SIX_HOURS_MS;
  if (Date.now() >= cycleEndMs) {
    return null;
  }

  const currentBounds = getCurrentCycleBounds();
  if (cycleStartMs !== currentBounds.cycleStartMs) {
    return null;
  }

  const msg = interaction.message ?? null;
  const msgId = msg?.id ?? null;

  let config = stockStore.get(channelId);
  const otherMain = Array.from(stockStore.values()).find(
    (c) => c.isMain && c.channelId !== channelId,
  );

  // If bot owner moved /stockset to a different channel, the old channel is superseded
  if (otherMain) {
    return null;
  }

  // If the channel config was wiped on an ephemeral reset, recover it right from the interaction
  if (!config || !config.isMain) {
    const guildId = interaction.guildId ?? msg?.guildId ?? null;
    if (!guildId) return null;

    config = {
      guildId,
      channelId,
      isMain: true,
      activeMessageId: msgId ?? config?.activeMessageId ?? null,
      updatedAt: Date.now(),
    };
    stockStore.set(channelId, config);
  }

  // If this embed was explicitly replaced by a newer /stockset post in the same channel, reject old message
  if (config.activeMessageId && msgId && config.activeMessageId !== msgId) {
    try {
      if (BigInt(msgId) < BigInt(config.activeMessageId)) {
        return null;
      }
      config.activeMessageId = msgId;
    } catch {
      return null;
    }
  } else if (!config.activeMessageId && msgId) {
    config.activeMessageId = msgId;
  }

  // Bring globalStock in sync if disk state was stale or wiped
  if (globalStock.cycleStartMs !== currentBounds.cycleStartMs) {
    globalStock.cycleStartMs = currentBounds.cycleStartMs;
    globalStock.nextRefreshMs = currentBounds.nextRefreshMs;
  }
  if (globalStock.fruits.length === 0 && msg) {
    const extracted = extractStockStateFromMessage(msg, interaction.client.user?.id);
    if (extracted && extracted.fruits.length > 0) {
      globalStock.fruits = [...extracted.fruits];
    }
  }

  saveStockConfigs();
  ensureStockWatchdog(interaction.client);
  return config;
}

// Handles dropdown selection on the main 6-hour stock message
export async function handleStockSelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const parts = interaction.customId.split(':');
  // Expected: stk_menu:<channelId>:<cycleStartMs>:<revision>
  const channelId = parts[1];
  const cycleStartMs = Number(parts[2]);

  const config = resolveActiveMainInteraction(interaction, channelId, cycleStartMs);
  if (!config) {
    await interaction.reply({
      content: 'This stock cycle has expired. Please use the latest stock message.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const selected = interaction.values[0];
  if (selected === 'noop') {
    globalStock.revision += 1;
    globalStock.updatedAt = Date.now();
    saveStockConfigs();

    const { payload } = await buildPayloadForChannel(interaction.client, config, false);
    await interaction.update(payload);
    await interaction.followUp({
      content: 'No fruits have been added to this stock yet. Select **add fruits** first.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!(await ensureMainStockInputPermission(interaction))) {
    return;
  }

  const isAdd = selected === 'add';
  if (!isAdd && globalStock.fruits.length === 0) {
    await interaction.reply({
      content: 'There are no fruits in stock to remove yet.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(
      `stk_modal:${isAdd ? 'add' : 'remove'}:${config.channelId}:${globalStock.cycleStartMs}`,
    )
    .setTitle(isAdd ? 'Add Fruits to Stock' : 'Remove Fruits from Stock');

  const label = new LabelBuilder()
    .setLabel(isAdd ? 'Fruits to add (comma separated)' : 'Fruits to remove (comma separated)')
    .setTextInputComponent(
      new TextInputBuilder()
        .setCustomId('fruits_input')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(isAdd ? 'e.g. dragon, dough, spin, ice' : 'e.g. dragon, spin')
        .setRequired(true)
        .setMaxLength(300),
    );

  modal.addLabelComponents(label);
  await interaction.showModal(modal);
}

// Handles modal submission for adding or removing comma-separated fruits on main embed
export async function handleStockModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const parts = interaction.customId.split(':');
  // Expected: stk_modal:<add|remove>:<channelId>:<cycleStartMs>
  const action = parts[1];
  const channelId = parts[2];
  const cycleStartMs = Number(parts[3]);

  const config = resolveActiveMainInteraction(interaction, channelId, cycleStartMs);
  if (!config) {
    await interaction.reply({
      content: 'This stock cycle has expired. Please use the latest stock message.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!(await ensureMainStockInputPermission(interaction))) {
    return;
  }

  const rawInput = interaction.fields.getTextInputValue('fruits_input');

  if (action === 'add') {
    const { matched, unmatched } = parseFruitInputList(rawInput, LEGACY_FRUITS_CATALOG);

    if (matched.length === 0) {
      await interaction.reply({
        content: `Could not match any Legacy Fruits from: \`${rawInput}\``,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const addedNames: string[] = [];
    for (const fruit of matched) {
      if (!globalStock.fruits.includes(fruit.id)) {
        globalStock.fruits.push(fruit.id);
        addedNames.push(fruit.name);
      }
    }

    globalStock.revision += 1;
    globalStock.updatedAt = Date.now();
    saveStockConfigs();

    const { payload } = await buildPayloadForChannel(interaction.client, config, false);
    let targetMessage: Message | null = interaction.message ?? null;
    if (interaction.isFromMessage()) {
      await interaction.update(payload);
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const channel = await resolveSendableChannel(interaction.client, config.channelId);
      if (channel && config.activeMessageId) {
        const msg = await channel.messages.fetch(config.activeMessageId).catch(() => null);
        if (msg && msg.editable) {
          await msg.edit(payload);
          targetMessage = msg;
        }
      }
      await interaction.deleteReply().catch(() => null);
    }

    // Add <:Win:...> and <:loss:...> reactions to the main stock message now that fruits are set
    void syncStockMessageReactions(targetMessage, globalStock.fruits.length > 0);

    // Mirror updated stock (and reactions) to all follower servers immediately
    void syncAllFollowerStockMessages(interaction.client);

    const notes: string[] = [];
    if (addedNames.length > 0) {
      notes.push(`Added: **${addedNames.join(', ')}**`);
    } else {
      notes.push('All matched fruits were already in the current stock.');
    }
    if (unmatched.length > 0) {
      notes.push(`Unrecognized: \`${unmatched.join(', ')}\``);
    }

    await interaction.followUp({
      content: notes.join('\n'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // action === 'remove'
  const currentCatalog = globalStock.fruits
    .map((id) => FRUIT_BY_ID.get(id))
    .filter((f): f is LegacyFruitEntry => Boolean(f));

  const { matched, unmatched } = parseFruitInputList(rawInput, currentCatalog);
  if (matched.length === 0) {
    await interaction.reply({
      content: `None of those fruits matched what is currently in stock: \`${rawInput}\``,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const removeSet = new Set(matched.map((f) => f.id));
  const removedNames = matched.map((f) => f.name);
  globalStock.fruits = globalStock.fruits.filter((id) => !removeSet.has(id));
  globalStock.revision += 1;
  globalStock.updatedAt = Date.now();
  saveStockConfigs();

  const { payload } = await buildPayloadForChannel(interaction.client, config, false);
  let targetMessage: Message | null = interaction.message ?? null;
  if (interaction.isFromMessage()) {
    await interaction.update(payload);
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = await resolveSendableChannel(interaction.client, config.channelId);
    if (channel && config.activeMessageId) {
      const msg = await channel.messages.fetch(config.activeMessageId).catch(() => null);
      if (msg && msg.editable) {
        await msg.edit(payload);
        targetMessage = msg;
      }
    }
    await interaction.deleteReply().catch(() => null);
  }

  // Keep Win/loss reactions synced depending on whether fruits remain in stock
  void syncStockMessageReactions(targetMessage, globalStock.fruits.length > 0);

  // Mirror updated stock to all follower servers immediately
  void syncAllFollowerStockMessages(interaction.client);

  const notes = [`Removed: **${removedNames.join(', ')}**`];
  if (unmatched.length > 0) {
    notes.push(`Not in current stock: \`${unmatched.join(', ')}\``);
  }

  await interaction.followUp({
    content: notes.join('\n'),
    flags: MessageFlags.Ephemeral,
  });
}

// Re-renders any active populated stock messages in a guild after /stockpings is modified
async function refreshActiveGuildStockMessages(
  client: Client,
  guildId: string,
): Promise<void> {
  if (globalStock.fruits.length === 0) return;

  for (const config of stockStore.values()) {
    if (config.guildId !== guildId || !config.activeMessageId) {
      continue;
    }
    const { channel, payload } = await buildPayloadForChannel(client, config, false);
    if (!channel) continue;
    const msg = await channel.messages.fetch(config.activeMessageId).catch(() => null);
    if (msg && msg.editable) {
      await msg.edit(payload).catch(() => null);
    }
  }
}

function parseDiscordEmoji(emojiStr: string): { id: string; name: string } | undefined {
  const match = emojiStr.match(/^<a?:([a-zA-Z0-9_]+):(\d+)>$/);
  if (!match) return undefined;
  return { name: match[1], id: match[2] };
}

function pruneOldPingSessions(): void {
  const cutoff = Date.now() - PING_SESSION_TTL_MS;
  for (const [id, session] of stockPingSessions.entries()) {
    if (session.createdAt < cutoff) {
      stockPingSessions.delete(id);
    }
  }
}

export function buildStockPingsContainer(
  session: StockPingSession,
  guild?: Guild | null,
): ContainerBuilder {
  const configuredLines: string[] = [];
  for (const fruit of FRUITS_PICKER_ORDER) {
    const roleId = getEffectiveFruitPingRoleId(session.guildId, fruit.id, guild);
    if (roleId) {
      const emoji = getFruitEmoji(fruit);
      const emojiPart = emoji ? `${emoji} ` : '';
      configuredLines.push(`${emojiPart}**${fruit.name}** • <@&${roleId}>`);
    }
  }

  const listText =
    configuredLines.length > 0
      ? configuredLines.join('\n')
      : '-# No fruit ping roles configured for this server yet.';

  const selectedFruit =
    FRUIT_BY_ID.get(session.selectedFruitId) ?? FRUITS_PICKER_ORDER[0];
  const selectedRoleId = getEffectiveFruitPingRoleId(
    session.guildId,
    selectedFruit.id,
    guild,
  );
  const selectedEmojiTag = getFruitEmoji(selectedFruit);
  const selectedEmoji = selectedEmojiTag ? `${selectedEmojiTag} ` : '';
  const selectedStatus = selectedRoleId ? `<@&${selectedRoleId}>` : 'None';

  const totalPages = Math.ceil(FRUITS_PICKER_ORDER.length / FRUITS_PER_PAGE);
  const safePage = Math.max(0, Math.min(session.page, totalPages - 1));
  const pageFruits = FRUITS_PICKER_ORDER.slice(
    safePage * FRUITS_PER_PAGE,
    (safePage + 1) * FRUITS_PER_PAGE,
  );

  const fruitOptions = pageFruits.map((fruit) => {
    const hasPing = Boolean(
      getEffectiveFruitPingRoleId(session.guildId, fruit.id, guild),
    );
    const opt = new StringSelectMenuOptionBuilder()
      .setLabel(hasPing ? `${fruit.name} ✓` : fruit.name)
      .setValue(fruit.id)
      .setDefault(fruit.id === selectedFruit.id);
    const parsedEmoji = parseDiscordEmoji(getFruitEmoji(fruit));
    if (parsedEmoji) {
      opt.setEmoji(parsedEmoji);
    }
    return opt;
  });

  const fruitMenuRow =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`stk_ping_fruit:${session.userId}:${selectedFruit.id}:${safePage}`)
        .setPlaceholder(`choose a fruit (page ${safePage + 1}/${totalPages})`)
        .addOptions(fruitOptions),
    );

  // RoleSelectMenuBuilder (Discord ComponentType.RoleSelect = 6) supports native typing/searching
  const roleMenuRow =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId(`stk_ping_role:${session.userId}:${selectedFruit.id}:${safePage}`)
        .setPlaceholder(`type or choose role for ${selectedFruit.name}`)
        .setMinValues(1)
        .setMaxValues(1),
    );

  const buttonRow =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`stk_ping_btn:page:${session.userId}:${selectedFruit.id}:${safePage}`)
        .setLabel(
          safePage === 0
            ? `Fruits Page 1/${totalPages} ▶`
            : `◀ Fruits Page ${safePage + 1}/${totalPages}`,
        )
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`stk_ping_btn:clear:${session.userId}:${selectedFruit.id}:${safePage}`)
        .setLabel('Remove Ping')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!selectedRoleId),
    );

  return new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## 🔔 Stock Pings\n${listText}`),
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `Selected: ${selectedEmoji}**${selectedFruit.name}** → ${selectedStatus}`,
      ),
    )
    .addActionRowComponents(fruitMenuRow)
    .addActionRowComponents(roleMenuRow)
    .addActionRowComponents(buttonRow);
}

// Resolves stateless /stockpings UI state from customId (never expires across restarts or deploys)
function resolveStockPingState(
  interaction: StringSelectMenuInteraction | RoleSelectMenuInteraction | ButtonInteraction,
  isButton = false,
): { action?: string; session: StockPingSession } | null {
  if (!interaction.guildId) return null;

  const parts = interaction.customId.split(':');
  const totalPages = Math.ceil(FRUITS_PICKER_ORDER.length / FRUITS_PER_PAGE);

  if (isButton) {
    // New stateless format: stk_ping_btn:<action>:<userId>:<selectedFruitId>:<page>
    if (parts.length >= 5 && FRUIT_BY_ID.has(parts[3])) {
      const action = parts[1];
      const userId = parts[2];
      const selectedFruitId = parts[3];
      const pageNum = Number(parts[4]);
      return {
        action,
        session: {
          id: userId,
          userId,
          guildId: interaction.guildId,
          selectedFruitId,
          page: Number.isFinite(pageNum)
            ? Math.max(0, Math.min(pageNum, totalPages - 1))
            : 0,
          revision: 0,
          createdAt: Date.now(),
        },
      };
    }

    // Legacy 3-part format: stk_ping_btn:<action>:<sessionId>
    const action = parts[1];
    const legacy = stockPingSessions.get(parts[2]);
    if (legacy) {
      return { action, session: legacy };
    }
    return {
      action,
      session: {
        id: interaction.user.id,
        userId: interaction.user.id,
        guildId: interaction.guildId,
        selectedFruitId: 'dragon',
        page: 0,
        revision: 0,
        createdAt: Date.now(),
      },
    };
  }

  // New stateless select format: stk_ping_<fruit|role>:<userId>:<selectedFruitId>:<page>
  if (parts.length >= 4 && FRUIT_BY_ID.has(parts[2])) {
    const userId = parts[1];
    const selectedFruitId = parts[2];
    const pageNum = Number(parts[3]);
    return {
      session: {
        id: userId,
        userId,
        guildId: interaction.guildId,
        selectedFruitId,
        page: Number.isFinite(pageNum)
          ? Math.max(0, Math.min(pageNum, totalPages - 1))
          : 0,
        revision: 0,
        createdAt: Date.now(),
      },
    };
  }

  // Legacy 3-part format: stk_ping_<fruit|role>:<sessionId>:<revision>
  const legacy = stockPingSessions.get(parts[1]);
  if (legacy) {
    return { session: legacy };
  }
  return {
    session: {
      id: interaction.user.id,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      selectedFruitId: 'dragon',
      page: 0,
      revision: 0,
      createdAt: Date.now(),
    },
  };
}

// Handles /stockpings for server owners (and bot owner) per guild
export async function handleStockPingsCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId || !interaction.guild) {
    await interaction.reply({
      content: 'Run `/stockpings` inside a server to configure its stock ping roles.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isGuildOwnerOrBotOwner(interaction)) {
    await interaction.reply({
      content: 'Only the server owner can use `/stockpings`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  pruneOldPingSessions();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const session: StockPingSession = {
    id,
    userId: interaction.user.id,
    guildId: interaction.guildId,
    selectedFruitId: 'dragon',
    page: 0,
    revision: 0,
    createdAt: Date.now(),
  };
  stockPingSessions.set(id, session);

  await interaction.reply({
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    components: [buildStockPingsContainer(session, interaction.guild)],
    allowedMentions: { parse: [], roles: [], users: [] },
  });
}

export async function handleStockPingsFruitSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const resolved = resolveStockPingState(interaction, false);
  if (!resolved) {
    await interaction.reply({
      content: 'Run `/stockpings` inside a server to configure its stock ping roles.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { session } = resolved;
  if (interaction.user.id !== session.userId && !isGuildOwnerOrBotOwner(interaction)) {
    await interaction.reply({
      content: 'Only the server owner can modify stock pings.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const pickedId = interaction.values[0];
  if (FRUIT_BY_ID.has(pickedId)) {
    session.selectedFruitId = pickedId;
  }
  session.revision += 1;

  await interaction.update({
    components: [buildStockPingsContainer(session, interaction.guild)],
    allowedMentions: { parse: [], roles: [], users: [] },
  });
}

export async function handleStockPingsRoleSelect(
  interaction: RoleSelectMenuInteraction,
): Promise<void> {
  const resolved = resolveStockPingState(interaction, false);
  if (!resolved) {
    await interaction.reply({
      content: 'Run `/stockpings` inside a server to configure its stock ping roles.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { session } = resolved;
  if (interaction.user.id !== session.userId && !isGuildOwnerOrBotOwner(interaction)) {
    await interaction.reply({
      content: 'Only the server owner can modify stock pings.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const roleId = interaction.values[0] ?? null;
  setFruitPingRoleId(session.guildId, session.selectedFruitId, roleId);
  session.revision += 1;
  void refreshActiveGuildStockMessages(interaction.client, session.guildId);

  await interaction.update({
    components: [buildStockPingsContainer(session, interaction.guild)],
    allowedMentions: { parse: [], roles: [], users: [] },
  });
}

export async function handleStockPingsButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const resolved = resolveStockPingState(interaction, true);
  if (!resolved) {
    await interaction.reply({
      content: 'Run `/stockpings` inside a server to configure its stock ping roles.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { action, session } = resolved;
  if (interaction.user.id !== session.userId && !isGuildOwnerOrBotOwner(interaction)) {
    await interaction.reply({
      content: 'Only the server owner can modify stock pings.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === 'page') {
    const totalPages = Math.ceil(FRUITS_PICKER_ORDER.length / FRUITS_PER_PAGE);
    session.page = (session.page + 1) % totalPages;
  } else if (action === 'clear') {
    setFruitPingRoleId(session.guildId, session.selectedFruitId, null);
    void refreshActiveGuildStockMessages(interaction.client, session.guildId);
  }
  session.revision += 1;

  await interaction.update({
    components: [buildStockPingsContainer(session, interaction.guild)],
    allowedMentions: { parse: [], roles: [], users: [] },
  });
}
