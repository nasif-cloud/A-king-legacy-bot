import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, loadImage, type Image } from '@napi-rs/canvas';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  ContainerBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThumbnailBuilder,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { KING_LEGACY_ITEMS, type KingLegacyItem } from './values.js';

const WIN_EMOJI = '<:Win:1573737872647786508>';
const LOSS_EMOJI = '<:loss:1573737870999421058>';
const SEA_KING_FIN_EMOJI = '<:sea_kings_fin:1573525889554063591>';
const SEA_KING_FIN_CDN =
  'https://cdn.discordapp.com/emojis/1573525889554063591.png?size=256';
const WIN_ACCENT_COLOR = 0x22c55e;
const LOSS_ACCENT_COLOR = 0xef4444;
const FAIR_ACCENT_COLOR = 0x3b82f6;
const SESSION_TTL_MS = 14 * 60 * 1000;

interface ParsedTradeItem {
  item: KingLegacyItem;
  qty: number;
}

interface WinLossSession {
  id: string;
  userId: string;
  expired: boolean;
  calculated: boolean;
  lastInteraction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | ModalSubmitInteraction;
  timeoutHandle?: NodeJS.Timeout;
}

const wlSessions = new Map<string, WinLossSession>();
let cachedFinImage: Image | null = null;
const avatarCache = new Map<string, Image>();

const BADGE_FONT_FAMILY = 'KingLegacyBadge';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Registers a bundled bold TTF font with Skia so badge text renders even in minimal Linux containers with no system fonts
function ensureBadgeFontRegistered(): string {
  if (GlobalFonts.has(BADGE_FONT_FAMILY)) {
    return BADGE_FONT_FAMILY;
  }

  const fontCandidates = [
    path.resolve(__dirname, 'fonts', 'NotoSans-Bold.ttf'),
    path.resolve(process.cwd(), 'src', 'bot', 'fonts', 'NotoSans-Bold.ttf'),
    '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  ];

  for (const fontPath of fontCandidates) {
    try {
      if (fs.existsSync(fontPath)) {
        const registered = GlobalFonts.registerFromPath(fontPath, BADGE_FONT_FAMILY);
        if (registered || GlobalFonts.has(BADGE_FONT_FAMILY)) {
          return BADGE_FONT_FAMILY;
        }
      }
    } catch {
      // Try next font candidate
    }
  }

  return 'Noto Sans';
}

// Slash command: /wl (Win or Loss Calculator)
export const winLossCommandData = new SlashCommandBuilder()
  .setName('wl')
  .setDescription('calculate if a trade is a win or loss');

function makeSessionId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// Formats fin amounts cleanly (e.g. 5, 3.5, 1,700) without floating point noise
function formatFinAmount(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  if (Number.isInteger(rounded)) {
    return rounded.toLocaleString('en-US');
  }
  return rounded.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

// Normalizes item text for fin-value catalog lookup
function normalizeLookupText(input: string): string {
  return input
    .replace(/<a?:([a-zA-Z0-9_]+):\d+>/g, ' $1 ')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Resolves a single item name against KING_LEGACY_ITEMS (strictly items with a fin value)
function findFinValueItem(rawName: string): KingLegacyItem | undefined {
  let cleaned = normalizeLookupText(rawName);
  if (!cleaned) return undefined;

  // Detect perm modifier cleanly so "perm dragon" never falls back to regular "Dragon Fruit"
  const isPermQuery = /^(?:perm|permanent|p)\s+/.test(cleaned);
  cleaned = cleaned.replace(/^(?:perm|permanent|p)\s+/, '').trim();

  // Strip trailing "s" plural or "fruit" unless exact match exists first
  const candidates = new Set<string>([cleaned]);
  if (cleaned.endsWith('s') && cleaned.length > 3) {
    candidates.add(cleaned.slice(0, -1));
  }
  if (cleaned.endsWith(' fruit')) {
    candidates.add(cleaned.replace(/\s+fruit$/, '').trim());
  }

  // Common short forms in King Legacy trading
  if (!isPermQuery) {
    if (cleaned === 'fin' || cleaned === 'fins' || cleaned === 'sk' || cleaned === 'skf' || cleaned === 'sk fins') {
      candidates.add('sk fin');
    }
    if (cleaned === 'dark beard' || cleaned === 'darkbeard') {
      candidates.add('dark beard hat');
    }
    if (cleaned === 'serpent' || cleaned === 'serpents') {
      candidates.add('serpent fin');
    }
  }

  const pool = KING_LEGACY_ITEMS.filter((item) => {
    if (typeof item.value !== 'number' || !Number.isFinite(item.value) || item.value <= 0) {
      return false;
    }
    const itemIsPerm = item.name.toLowerCase().startsWith('perm ');
    return isPermQuery ? itemIsPerm : !itemIsPerm;
  });

  // 1) Exact match against item name (without "perm "/"fruit"/"(mats)") or aliases
  for (const cand of candidates) {
    const exact = pool.find((item) => {
      const baseName = normalizeLookupText(item.name)
        .replace(/^perm\s+/, '')
        .replace(/\s*\(mats\)\s*/g, '')
        .trim();
      const noFruit = baseName.replace(/\s+fruit$/, '').trim();
      if (baseName === cand || noFruit === cand) return true;
      return item.aliases.some((alias) => {
        const cleanAlias = normalizeLookupText(alias)
          .replace(/^perm\s+/, '')
          .replace(/\s*\(mats\)\s*/g, '')
          .trim();
        return cleanAlias === cand;
      });
    });
    if (exact) return exact;
  }

  // 2) Safe word-boundary prefix match when unambiguous (length >= 3)
  if (cleaned.length >= 3) {
    const prefix = pool.find((item) => {
      const baseName = normalizeLookupText(item.name)
        .replace(/^perm\s+/, '')
        .replace(/\s*\(mats\)\s*/g, '')
        .trim();
      return (
        baseName.startsWith(cleaned) ||
        item.aliases.some((alias) =>
          normalizeLookupText(alias)
            .replace(/^perm\s+/, '')
            .startsWith(cleaned),
        )
      );
    });
    if (prefix) return prefix;
  }

  return undefined;
}

// Parses a side of a trade (e.g. "Perm dragon, 2 serpent fin") into fin-valued items
function parseTradeSide(rawInput: string): {
  items: ParsedTradeItem[];
  unknown: string[];
  totalValue: number;
} {
  // Split on commas, newlines, "&", "and", or spaced " + " (preserving "+1 slot", "+1 storage")
  const parts = rawInput
    .split(/,+|\r?\n+|\s+&\s+|\s+and\s+|\s+\+\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);

  const items: ParsedTradeItem[] = [];
  const unknown: string[] = [];

  for (const part of parts) {
    let working = part.trim();
    let qty = 1;

    // Leading quantity like "2 serpent fin", "2x dragon", "x2 toy"
    const leadingMatch = /^(?:x\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*x?)\s+(.+)$/i.exec(
      working,
    );
    if (leadingMatch && !/^\+\d/.test(working)) {
      qty = Number(leadingMatch[1] ?? leadingMatch[2]);
      working = leadingMatch[3].trim();
    } else {
      // Trailing quantity like "dragon x2" or "dragon 2x"
      const trailingMatch = /^(.+?)\s+(?:x\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*x)$/i.exec(
        working,
      );
      if (trailingMatch) {
        working = trailingMatch[1].trim();
        qty = Number(trailingMatch[2] ?? trailingMatch[3]);
      }
    }

    if (!Number.isFinite(qty) || qty <= 0) {
      unknown.push(part);
      continue;
    }

    const found = findFinValueItem(working);
    if (!found) {
      unknown.push(part);
      continue;
    }

    items.push({ item: found, qty });
  }

  const totalValue = items.reduce((sum, entry) => sum + entry.item.value * entry.qty, 0);
  return {
    items,
    unknown,
    totalValue: Math.round(totalValue * 100) / 100,
  };
}

const PERM_EMOJI = '<:perm:1573753303274098829>';

// Formats parsed items into comma-separated emoji icon tokens (with perm badge and qty prefix)
function formatTradeSideIcons(items: ParsedTradeItem[]): string {
  return items
    .map(({ item, qty }) => {
      const qtyPrefix = qty !== 1 ? `${formatFinAmount(qty)}x ` : '';
      const isPerm = item.name.toLowerCase().startsWith('perm ');
      if (item.emoji) {
        return isPerm
          ? `${qtyPrefix}${PERM_EMOJI}${item.emoji}`
          : `${qtyPrefix}${item.emoji}`;
      }
      return `${qtyPrefix}${item.name}`;
    })
    .join(', ');
}

// Loads and caches the Sea King Fin emoji PNG for fast canvas rendering
async function getFinImage(): Promise<Image | null> {
  if (cachedFinImage) return cachedFinImage;
  try {
    const res = await fetch(SEA_KING_FIN_CDN);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    cachedFinImage = await loadImage(buf);
    return cachedFinImage;
  } catch {
    return null;
  }
}

// Fetches and caches a user's Discord avatar image (capped at 50 entries)
async function getUserAvatarImage(avatarUrl: string | null): Promise<Image | null> {
  if (!avatarUrl) return null;
  const cached = avatarCache.get(avatarUrl);
  if (cached) return cached;

  try {
    const res = await fetch(avatarUrl);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const img = await loadImage(buf);
    if (avatarCache.size >= 50) {
      const oldestKey = avatarCache.keys().next().value;
      if (oldestKey) avatarCache.delete(oldestKey);
    }
    avatarCache.set(avatarUrl, img);
    return img;
  } catch {
    return null;
  }
}

// Returns true when the trade difference is 0% or within 10% (fair trade)
function isFairTradeDifference(youTotal: number, themTotal: number): boolean {
  const absDiff = Math.abs(themTotal - youTotal);
  if (absDiff === 0) return true;
  const maxSide = Math.max(youTotal, themTotal);
  if (maxSide <= 0) return true;
  const pctDiff = (absDiff / maxSide) * 100;
  return pctDiff <= 10 + 1e-9;
}

// Draws the Sea King Fin over the user's PFP + 6-color 20% gradient, with a top-right value badge
export async function drawFinDeltaThumbnail(
  amount: number,
  sign: '-' | '+' | 'fair',
  avatarUrl: string | null,
  isFair = sign === 'fair',
): Promise<Buffer> {
  const size = 300;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // 1) Background: user's PFP full-bleed softened slightly so the 20% gradient and fin pop cleanly
  const avatarImg = await getUserAvatarImage(avatarUrl);
  if (avatarImg) {
    ctx.save();
    ctx.filter = 'blur(1.5px) contrast(0.88) brightness(1.06)';
    ctx.drawImage(avatarImg, -4, -4, size + 8, size + 8);
    ctx.restore();
  } else {
    ctx.fillStyle = '#2b2d31';
    ctx.fillRect(0, 0, size, size);
  }

  // 2) 6-color red/green/blue gradient overlay at 20% opacity
  if (amount > 0 || isFair) {
    const stops = isFair
      ? ['#eff6ff', '#dbeafe', '#93c5fd', '#60a5fa', '#3b82f6', '#1d4ed8']
      : sign === '+'
        ? ['#f0fdf4', '#bbf7d0', '#86efac', '#4ade80', '#22c55e', '#15803d']
        : ['#fff1f2', '#fecdd3', '#fda4af', '#fb7185', '#ef4444', '#b91c1c'];

    const grad = ctx.createLinearGradient(0, 0, size, size);
    stops.forEach((color, idx) => {
      grad.addColorStop(idx / (stops.length - 1), color);
    });

    ctx.save();
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    ctx.restore();
  }

  // 3) Large Sea King Fin emoji positioned cleanly in lower-left/center
  const finImg = await getFinImage();
  if (finImg) {
    ctx.drawImage(finImg, 12, 34, 274, 256);
  } else {
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.moveTo(40, 260);
    ctx.quadraticCurveTo(90, 60, 230, 80);
    ctx.quadraticCurveTo(185, 175, 220, 250);
    ctx.closePath();
    ctx.fill();
  }

  // 4) Top-right rounded badge with thick black border and bold black -<amount> / +<amount> / 0
  const label = sign === 'fair' || amount === 0 ? '0' : `${sign}${formatFinAmount(amount)}`;
  let fontSize = 58;
  if (label.length >= 4) fontSize = 48;
  if (label.length >= 6) fontSize = 38;
  if (label.length >= 8) fontSize = 32;

  const fontFamily = ensureBadgeFontRegistered();
  ctx.font = `bold ${fontSize}px "${fontFamily}", "Noto Sans", "DejaVu Sans", "Liberation Sans", sans-serif`;
  const textWidth = ctx.measureText(label).width;
  const pillWidth = Math.min(size - 32, Math.max(150, textWidth + 46));
  const pillHeight = 88;
  const pillX = size - pillWidth - 16;
  const pillY = 18;

  ctx.fillStyle = isFair
    ? '#60a5fa'
    : amount === 0
      ? '#cbd5e1'
      : sign === '+'
        ? '#4ade80'
        : '#ff5a54';
  ctx.beginPath();
  ctx.roundRect(pillX, pillY, pillWidth, pillHeight, 18);
  ctx.fill();

  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 7;
  ctx.stroke();

  // Stroke + fill in black for a chunky rounded numeral look
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#000000';
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const textCenterX = pillX + pillWidth / 2;
  const textCenterY = pillY + pillHeight / 2 + 2;
  ctx.strokeText(label, textCenterX, textCenterY, pillWidth - 20);
  ctx.fillText(label, textCenterX, textCenterY, pillWidth - 20);

  return canvas.toBuffer('image/png');
}

// Builds the initial Win or Loss prompt container
function buildWinLossPromptContainer(session: WinLossSession): ContainerBuilder {
  const container = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ⚖️ Win or Loss?\nCheck if your trade is a **${WIN_EMOJI} Win** or **${LOSS_EMOJI} Loss** before doing it`,
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addActionRowComponents(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`wl_calc:${session.id}`)
          .setLabel('calculate')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(session.expired),
      ),
    );

  if (session.expired) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('-# expired'),
    );
  }

  return container;
}

// Builds the calculated Win or Loss result container (green for win, red for loss, blue for fair)
function buildWinLossResultContainer(
  youIcons: string,
  themIcons: string,
  youTotal: number,
  themTotal: number,
): ContainerBuilder {
  const diff = Math.round((themTotal - youTotal) * 100) / 100;
  const absDiff = Math.abs(diff);
  const isFair = isFairTradeDifference(youTotal, themTotal);
  let resultLine: string;
  if (isFair) {
    resultLine = `Result: It's a **fair trade** (**${formatFinAmount(absDiff)}** ${SEA_KING_FIN_EMOJI} difference)`;
  } else if (diff > 0) {
    resultLine = `Result: You're **winning** by **${formatFinAmount(diff)}** ${SEA_KING_FIN_EMOJI}`;
  } else {
    resultLine = `Result: You're **losing** by **${formatFinAmount(absDiff)}** ${SEA_KING_FIN_EMOJI}`;
  }

  const container = new ContainerBuilder().setAccentColor(
    isFair ? FAIR_ACCENT_COLOR : diff > 0 ? WIN_ACCENT_COLOR : LOSS_ACCENT_COLOR,
  );

  const youHeader = isFair
    ? '### ⚖️ YOU:'
    : diff > 0
      ? `### ${WIN_EMOJI} YOU:`
      : `### ${LOSS_EMOJI} YOU:`;
  const themHeader = isFair
    ? '### ⚖️ THEM:'
    : diff > 0
      ? `### ${LOSS_EMOJI} THEM:`
      : `### ${WIN_EMOJI} THEM:`;

  return container
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`${youHeader}\n## ${youIcons}`),
        )
        .setThumbnailAccessory(
          new ThumbnailBuilder().setURL('attachment://you_fin.png'),
        ),
    )
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`${themHeader}\n## ${themIcons}`),
        )
        .setThumbnailAccessory(
          new ThumbnailBuilder().setURL('attachment://them_fin.png'),
        ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(resultLine));
}

// Expires unclaimed calculator prompts cleanly after 14 minutes
function refreshSessionTimeout(session: WinLossSession): void {
  if (session.timeoutHandle) {
    clearTimeout(session.timeoutHandle);
  }

  session.timeoutHandle = setTimeout(async () => {
    session.expired = true;
    wlSessions.delete(session.id);
    if (session.calculated) return;

    try {
      await session.lastInteraction.editReply({
        components: [buildWinLossPromptContainer(session)],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch {
      // Ephemeral token may have already expired or message was dismissed
    }
  }, SESSION_TTL_MS);
}

// Handles "/wl" command execution
export async function handleWinLossCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const session: WinLossSession = {
    id: makeSessionId(),
    userId: interaction.user.id,
    expired: false,
    calculated: false,
    lastInteraction: interaction,
  };

  wlSessions.set(session.id, session);
  refreshSessionTimeout(session);

  await interaction.reply({
    components: [buildWinLossPromptContainer(session)],
    flags: MessageFlags.IsComponentsV2,
  });
}

// Handles clicking the "calculate" button -> opens the two-field trade modal
export async function handleWinLossButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const [prefix, sessionId] = interaction.customId.split(':');
  if (prefix !== 'wl_calc') return;

  const session = wlSessions.get(sessionId);
  if (!session || session.expired) {
    if (!session) {
      await new Promise((resolve) => setTimeout(resolve, 1800));
    }
    await interaction.reply({
      content: 'This calculator expired, run /wl again',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (session.userId !== interaction.user.id) {
    await interaction.reply({
      content: `Only <@${session.userId}> can use this calculator`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  session.lastInteraction = interaction;
  refreshSessionTimeout(session);

  const modal = new ModalBuilder()
    .setCustomId(`wl_modal:${session.id}`)
    .setTitle('Win or Loss Calculator')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Your trade')
        .setDescription('ex. Perm dragon, 2 serpent fin')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('your_trade')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(300),
        ),
      new LabelBuilder()
        .setLabel('their trade')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('their_trade')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(300),
        ),
    );

  await interaction.showModal(modal);
}

// Handles submitting the two-field W/L trade modal and updates the component with canvas thumbnails
export async function handleWinLossModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const [prefix, sessionId] = interaction.customId.split(':');
  if (prefix !== 'wl_modal') return;

  const session = wlSessions.get(sessionId);
  if (!session || session.expired || session.userId !== interaction.user.id) {
    if (!session) {
      await new Promise((resolve) => setTimeout(resolve, 1800));
    }
    await interaction.reply({
      content: 'This calculator expired, run /wl again',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const yourRaw = interaction.fields.getTextInputValue('your_trade').trim();
  const theirRaw = interaction.fields.getTextInputValue('their_trade').trim();

  const yourParsed = parseTradeSide(yourRaw);
  const theirParsed = parseTradeSide(theirRaw);

  const missingItems = [...yourParsed.unknown, ...theirParsed.unknown];
  if (missingItems.length > 0 || yourParsed.items.length === 0 || theirParsed.items.length === 0) {
    const missingText =
      missingItems.length > 0
        ? `No fin value found for: **${missingItems.join('**, **')}**`
        : 'Please enter valid King Legacy items with a fin value';
    await interaction.reply({
      content: `${missingText} — check item names with /value`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();
  session.lastInteraction = interaction;
  session.calculated = true;
  refreshSessionTimeout(session);

  const userAvatarUrl = interaction.user.displayAvatarURL({
    size: 256,
    extension: 'png',
  });
  const botAvatarUrl =
    interaction.client.user?.displayAvatarURL({
      size: 256,
      extension: 'png',
    }) ?? null;

  const diff = Math.round((theirParsed.totalValue - yourParsed.totalValue) * 100) / 100;
  const absDiff = Math.abs(diff);
  const isFair = isFairTradeDifference(
    yourParsed.totalValue,
    theirParsed.totalValue,
  );
  const youSign: '-' | '+' | 'fair' = diff === 0 ? 'fair' : diff > 0 ? '+' : '-';
  const themSign: '-' | '+' | 'fair' = diff === 0 ? 'fair' : diff > 0 ? '-' : '+';

  const [youPng, themPng] = await Promise.all([
    drawFinDeltaThumbnail(absDiff, youSign, userAvatarUrl, isFair),
    drawFinDeltaThumbnail(absDiff, themSign, botAvatarUrl, isFair),
  ]);

  const youIcons = formatTradeSideIcons(yourParsed.items);
  const themIcons = formatTradeSideIcons(theirParsed.items);

  const resultContainer = buildWinLossResultContainer(
    youIcons,
    themIcons,
    yourParsed.totalValue,
    theirParsed.totalValue,
  );

  await interaction.editReply({
    components: [resultContainer],
    files: [
      new AttachmentBuilder(youPng, { name: 'you_fin.png' }),
      new AttachmentBuilder(themPng, { name: 'them_fin.png' }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}
