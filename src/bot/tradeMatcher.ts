import {
  ChannelType,
  Client,
  PermissionsBitField,
  type GuildBasedChannel,
  type Message,
} from 'discord.js';
import { KING_LEGACY_ITEMS } from './values.js';

// Maximum age for indexed trades (24 hours in milliseconds)
export const TRADE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FETCH_PAGES_PER_CHANNEL = 50; // Up to 5,000 messages per channel within 24h

// Stores one cached trade message pulled from a trading channel
export interface IndexedTrade {
  messageId: string;
  channelId: string;
  channelName: string;
  guildId: string;
  guildName: string;
  guildIconUrl: string;
  authorId: string;
  authorUsername: string;
  content: string;
  createdTimestamp: number;
  lfText: string;
  offeringText: string;
  expandedFullText: string;
  hasLfKeyword: boolean;
  hasOfferKeyword: boolean;
}

export type SearchMode = 'lf' | 'offering';

// Fallback grey Discord logo URL when a server has no custom icon
const DEFAULT_GUILD_ICON_URL = 'https://cdn.discordapp.com/embed/avatars/0.png';

// Channel name keywords used to recognize trading channels across servers
const TRADING_CHANNEL_REGEX =
  /(?:^|[-_|\s])(trade|trades|trading|lf|offer|offers|wtt|wtb|wts|market|bazaar|exchange)(?:$|[-_|\s\d])|trade|trading/i;

// Known item vocabulary built from values.ts so typos like "erbus" can map to "erebus"
const ITEM_VOCABULARY: Array<{
  canonicalName: string;
  isPerm: boolean;
  coreWords: string[];
  aliases: string[];
}> = KING_LEGACY_ITEMS.map((item) => {
  const cleanName = item.name.toLowerCase();
  const isPerm = cleanName.startsWith('perm ');
  const withoutPerm = cleanName
    .replace(/^perm\s+/, '')
    .replace(/\s*\(mats\)\s*/g, '');
  const words = withoutPerm
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && w !== 'fruit');

  return {
    canonicalName: withoutPerm.trim(),
    isPerm,
    coreWords: words,
    aliases: item.aliases
      .map((a) =>
        a
          .toLowerCase()
          .replace(/^perm\s+/, '')
          .replace(/[^a-z0-9\s]/g, ' ')
          .trim(),
      )
      .filter(Boolean),
  };
});

// In-memory store of indexed trade messages keyed by Discord message ID
const tradeCache = new Map<string, IndexedTrade>();
let lastSyncTimestamp = 0;
let activeSyncPromise: Promise<number> | null = null;

// Splits camelCase / underscore emoji names (e.g. "Kldragonfruit" -> "kl dragon fruit")
function splitEmojiName(rawName: string): string {
  return rawName
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
}

// Checks if an emoji name represents an LF (Looking For) marker like :lf:, :l_f:, :lookingfor:
function isLfEmojiName(name: string): boolean {
  const lower = name.toLowerCase().replace(/[^a-z0-9_]/g, '');
  return (
    /(?:^|_)l_?f(?:$|_|\d)/.test(lower) ||
    lower.includes('lookingfor') ||
    lower.includes('looking_for') ||
    /(?:^|_)(?:want|need|wishlist|wtb|buying)(?:$|_|\d)/.test(lower)
  );
}

// Checks if an emoji name represents an Offering marker like :offer: or :tradingofferarrow:
function isOfferEmojiName(name: string): boolean {
  const lower = name.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (isLfEmojiName(lower)) return false;
  return (
    lower.includes('offer') ||
    lower.includes('myhave') ||
    /(?:^|_)(?:have|trading|ft|wts|selling)(?:$|_|\d)/.test(lower)
  );
}

// Checks if an emoji name marks the transition from Offering -> LF (like :pointtrade: or :arrow:)
function isTransitionEmojiName(name: string): boolean {
  const lower = name.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (isLfEmojiName(lower) || isOfferEmojiName(lower)) return false;
  return (
    lower.includes('pointtrade') ||
    lower.includes('point_trade') ||
    lower.includes('pointright') ||
    lower.includes('point_right') ||
    lower.includes('tradearrow') ||
    lower.includes('trade_arrow') ||
    lower.includes('rightarrow') ||
    lower.includes('right_arrow') ||
    lower.includes('arrow') ||
    lower === 'for' ||
    lower === 'point' ||
    lower === 'swap'
  );
}

interface ParsedToken {
  kind: 'text' | 'lf_marker' | 'offer_marker' | 'transition_marker';
  value: string;
}

// Breaks a raw Discord message into text + trade section markers (emojis & keywords)
function tokenizeTradeMessage(rawContent: string): {
  tokens: ParsedToken[];
  expandedFullText: string;
} {
  const tokens: ParsedToken[] = [];
  const expandedParts: string[] = [];
  const emojiRegex = /<a?:([a-zA-Z0-9_]+):\d+>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const pushTextWithKeywords = (rawChunk: string) => {
    // Normalize unicode trade arrows to ASCII "->" via alternation so multi-codepoint emojis don't double-replace
    const normalizedArrows = rawChunk.replace(
      /➡️|➡|👉|➔|➜|➝|➞|⟶|⇄|🔁|🔄/g,
      ' -> ',
    );

    // Strip Discord markdown formatting (* _ ~ ` • and line-leading blockquote >) while preserving "->" and "=>"
    const chunk = normalizedArrows
      .replace(/[*_~`•]/g, ' ')
      .replace(/(^|\n)\s*>+/g, '$1 ')
      .replace(/(^|\s)-(?!>)/g, '$1 ');

    expandedParts.push(chunk);

    // Match trade section keywords, including common chat typos ("offeri g", "l.f") and colon labels ("my:", "your:")
    const keywordRegex =
      /(?:^|[\s,|/(\[])(anyone\s+(?:trading|got|have)|who\s+has|looking\s+for|lookin\s+for|lookng\s+for|looking\s*4|looking(?=\s*[:\-])|l\s*[/.\s]\s*f|lf|wanting|want|need|buying|wtb|wishlist(?=\s*[:\-])|your?(?=\s*[:\-])|get(?=\s*[:\-])|w(?=\s*:)|offeri\s*g|offering|offring|offr|my\s+offer|i\s+offer|offer(?=\s*[:\-])|trading|tradin|trding|giving|give(?=\s*[:\-])|selling|wts|have|has(?=\s*[:\-])|got(?=\s*[:\-])|my(?=\s*[:\-])|me(?=\s*[:\-])|h(?=\s*:)|ft(?=\s*[:\-])|fs(?=\s*[:\-])|for|->|=>)(?=$|[\s:,|/)\]])/gi;

    let pos = 0;
    let kwMatch: RegExpExecArray | null;
    while ((kwMatch = keywordRegex.exec(chunk)) !== null) {
      const fullStart = kwMatch.index;
      const kwStart = fullStart + kwMatch[0].length - kwMatch[1].length;
      if (kwStart > pos) {
        tokens.push({ kind: 'text', value: chunk.slice(pos, kwStart) });
      }

      const kw = kwMatch[1].toLowerCase().replace(/\s+/g, ' ');
      const compactKw = kw.replace(/[\s./]/g, '');

      if (
        compactKw === 'lf' ||
        kw.startsWith('looking') ||
        kw.startsWith('lookin') ||
        kw.startsWith('lookng') ||
        kw.startsWith('anyone ') ||
        kw === 'who has' ||
        kw === 'want' ||
        kw === 'wanting' ||
        kw === 'need' ||
        kw === 'buying' ||
        kw === 'wtb' ||
        kw === 'wishlist' ||
        kw === 'you' ||
        kw === 'your' ||
        kw === 'get' ||
        kw === 'w'
      ) {
        tokens.push({ kind: 'lf_marker', value: kw });
      } else if (
        kw === 'for' ||
        kw === '->' ||
        kw === '=>'
      ) {
        // "for", "->", "=>" act as a transition from offering (left) to LF (right)
        tokens.push({ kind: 'transition_marker', value: kw });
      } else {
        tokens.push({ kind: 'offer_marker', value: kw });
      }

      pos = kwStart + kwMatch[1].length;
    }

    if (pos < chunk.length) {
      tokens.push({ kind: 'text', value: chunk.slice(pos) });
    }
  };

  while ((match = emojiRegex.exec(rawContent)) !== null) {
    if (match.index > lastIndex) {
      pushTextWithKeywords(rawContent.slice(lastIndex, match.index));
    }

    const emojiName = match[1];
    const splitWords = splitEmojiName(emojiName);
    const compactNoKl = emojiName.toLowerCase().replace(/^kl_?/, '');
    expandedParts.push(` ${splitWords} ${compactNoKl} `);

    if (isLfEmojiName(emojiName)) {
      tokens.push({ kind: 'lf_marker', value: emojiName });
    } else if (isOfferEmojiName(emojiName)) {
      tokens.push({ kind: 'offer_marker', value: emojiName });
    } else if (isTransitionEmojiName(emojiName)) {
      tokens.push({ kind: 'transition_marker', value: emojiName });
    } else {
      tokens.push({
        kind: 'text',
        value: ` ${splitWords} ${compactNoKl} `,
      });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < rawContent.length) {
    pushTextWithKeywords(rawContent.slice(lastIndex));
  }

  return {
    tokens,
    expandedFullText: expandedParts.join(' ').trim(),
  };
}

// Extracts separate "LF" and "Offering" text blocks plus marker flags from a trade message
export function extractTradeSections(rawContent: string): {
  lfText: string;
  offeringText: string;
  expandedFullText: string;
  hasLfKeyword: boolean;
  hasOfferKeyword: boolean;
} {
  const { tokens, expandedFullText } = tokenizeTradeMessage(rawContent);
  const lfParts: string[] = [];
  const offerParts: string[] = [];
  const unknownParts: string[] = [];

  let currentSection: 'unknown' | 'offer' | 'lf' = 'unknown';
  let hasLfKeyword = false;
  let hasOfferKeyword = false;

  const flushUnknownAsOffer = () => {
    if (unknownParts.length > 0) {
      offerParts.push(...unknownParts);
      unknownParts.length = 0;
    }
  };

  for (const token of tokens) {
    if (token.kind === 'offer_marker') {
      hasOfferKeyword = true;
      currentSection = 'offer';
      continue;
    }

    if (token.kind === 'lf_marker') {
      hasLfKeyword = true;
      flushUnknownAsOffer();
      currentSection = 'lf';
      continue;
    }

    if (token.kind === 'transition_marker') {
      // Text before :pointtrade: or "for" is the offering side, text after is LF
      hasOfferKeyword = true;
      hasLfKeyword = true;
      flushUnknownAsOffer();
      currentSection = 'lf';
      continue;
    }

    const cleaned = token.value.trim();
    if (!cleaned) continue;

    if (currentSection === 'lf') {
      lfParts.push(cleaned);
    } else if (currentSection === 'offer') {
      offerParts.push(cleaned);
    } else {
      unknownParts.push(cleaned);
    }
  }

  return {
    lfText: lfParts.join(' ').trim(),
    offeringText: offerParts.join(' ').trim(),
    expandedFullText,
    hasLfKeyword,
    hasOfferKeyword,
  };
}

// Checks whether two single words match strictly (exact word, stripped emoji core, or plural "s")
function wordsExactMatch(queryWord: string, targetWord: string): boolean {
  if (!queryWord || !targetWord) return false;
  if (queryWord === targetWord) return true;

  // Strip common emoji prefixes/suffixes like "kl", "fruit", "icon", trailing digits
  const strippedTarget = targetWord
    .replace(/^kl/, '')
    .replace(/(?:fruit|icon|emoji)\d*$/, '')
    .replace(/\d+$/, '');

  if (queryWord === strippedTarget) return true;

  // Handle plural 's' cleanly (e.g. "toys" <-> "toy", "fins" <-> "fin")
  if (
    queryWord.length >= 3 &&
    (`${queryWord}s` === strippedTarget || queryWord === `${strippedTarget}s`)
  ) {
    return true;
  }

  return false;
}

// Normalizes text into alphanumeric tokens, separating quantities like "2x" or "2toy" -> "2 toy"
function toWordTokens(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/(\d+)\s*x\b/g, '$1 ')
    .replace(/\bx\s*(\d+)/g, ' $1 ')
    .replace(/(\d+)([a-z]{2,})/g, '$1 $2')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// Expands known exact King Legacy aliases (e.g. "atk" <-> "authentic triple katana") without fuzzy guessing
function expandClauseWithCatalog(clauseWords: string[]): string[][] {
  const variants: string[][] = [clauseWords];
  const joined = clauseWords.join(' ');

  for (const item of ITEM_VOCABULARY) {
    if (item.aliases.some((alias) => alias === joined)) {
      variants.push(item.coreWords);
      continue;
    }

    if (
      clauseWords.length === item.coreWords.length &&
      clauseWords.every((w, i) => wordsExactMatch(w, item.coreWords[i]))
    ) {
      variants.push(item.coreWords);
    }
  }

  return variants;
}

interface ParsedQueryClause {
  qty: string | null;
  perm: boolean;
  wordVariants: string[][];
}

// Splits a user's search input like "Perm Erebus, 2 Serpent fin" into structured clauses
function parseSearchQuery(rawQuery: string): ParsedQueryClause[] {
  // Strip accidental leading mode words if user typed e.g. "lf toy" or "offering dragon"
  const cleanedQuery = rawQuery
    .trim()
    .replace(/^(?:l\s*\/?\s*f|looking\s+for|offering|offer|trading)\s*:?\s+/i, '');

  const parts = cleanedQuery
    .split(/[,+\n&]+|\band\b/i)
    .map((p) => p.trim())
    .filter(Boolean);

  const clauses: ParsedQueryClause[] = [];

  for (const part of parts) {
    const tokens = toWordTokens(part);
    let qty: string | null = null;
    let perm = false;
    const itemWords: string[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok === 'perm' || tok === 'permanent' || (tok === 'p' && i < tokens.length - 1)) {
        perm = true;
      } else if (/^\d+$/.test(tok) && !qty) {
        qty = tok;
      } else if (tok !== 'fruit' && tok !== 'fruits') {
        itemWords.push(tok);
      }
    }

    if (itemWords.length === 0 && tokens.includes('fruit')) {
      itemWords.push('fruit');
    }

    if (itemWords.length > 0) {
      clauses.push({
        qty,
        perm,
        wordVariants: expandClauseWithCatalog(itemWords),
      });
    }
  }

  return clauses;
}

// Finds every occurrence where a multi-word or single-word variant appears cleanly in targetTokens
function findPhraseMatchWindows(
  targetTokens: string[],
  variantWords: string[],
): Array<{ minIdx: number; maxIdx: number; tokenHasPermPrefix: boolean }> {
  const windows: Array<{
    minIdx: number;
    maxIdx: number;
    tokenHasPermPrefix: boolean;
  }> = [];

  if (variantWords.length === 1) {
    const qw = variantWords[0];
    for (let i = 0; i < targetTokens.length; i++) {
      const tw = targetTokens[i];
      const noPerm = tw.replace(/^perm/, '');
      const hasPermPrefix = tw.startsWith('perm') && noPerm.length >= 2;
      if (wordsExactMatch(qw, tw) || (hasPermPrefix && wordsExactMatch(qw, noPerm))) {
        windows.push({
          minIdx: i,
          maxIdx: i,
          tokenHasPermPrefix: hasPermPrefix,
        });
      }
    }
    return windows;
  }

  // Multi-word queries (e.g. ["dark", "beard"]): check nearby occurrences first so earlier unrelated words don't block later ones
  const firstWord = variantWords[0];
  const maxSpan = variantWords.length + 2;

  for (let start = 0; start < targetTokens.length; start++) {
    const startTok = targetTokens[start];
    const startNoPerm = startTok.replace(/^perm/, '');
    const startHasPerm = startTok.startsWith('perm') && startNoPerm.length >= 2;

    if (
      !wordsExactMatch(firstWord, startTok) &&
      !(startHasPerm && wordsExactMatch(firstWord, startNoPerm))
    ) {
      continue;
    }

    const endLimit = Math.min(targetTokens.length - 1, start + maxSpan);
    const matchedIndices = [start];
    let allFoundNearby = true;

    for (let wi = 1; wi < variantWords.length; wi++) {
      const qw = variantWords[wi];
      let foundAt = -1;
      for (let ti = start; ti <= endLimit; ti++) {
        if (matchedIndices.includes(ti)) continue;
        if (wordsExactMatch(qw, targetTokens[ti])) {
          foundAt = ti;
          break;
        }
      }
      if (foundAt === -1) {
        allFoundNearby = false;
        break;
      }
      matchedIndices.push(foundAt);
    }

    if (allFoundNearby) {
      windows.push({
        minIdx: Math.min(...matchedIndices),
        maxIdx: Math.max(...matchedIndices),
        tokenHasPermPrefix: startHasPerm,
      });
    }
  }

  // Also check joined multi-word emoji/chat tokens like "darkbeard", "darkbeardhat", or "permdarkbeard"
  const joinedVariant = variantWords.join('');
  for (let i = 0; i < targetTokens.length; i++) {
    const tw = targetTokens[i];
    const noPerm = tw.replace(/^perm/, '');
    const hasPermPrefix = tw.startsWith('perm') && noPerm.length >= 4;
    const strippedTarget = noPerm
      .replace(/^kl/, '')
      .replace(/(?:fruit|icon|emoji)\d*$/, '')
      .replace(/\d+$/, '');

    const matchesJoined =
      wordsExactMatch(joinedVariant, strippedTarget) ||
      (joinedVariant.length >= 6 &&
        new RegExp(`^${joinedVariant}(?:s|hat|totem|fruit|icon|emoji|\\d)*$`).test(
          strippedTarget,
        ));

    if (matchesJoined) {
      windows.push({
        minIdx: i,
        maxIdx: i,
        tokenHasPermPrefix: hasPermPrefix,
      });
    }
  }

  return windows;
}

// Checks whether all clauses of a search query match a given text block
function matchesSectionText(
  sectionText: string,
  clauses: ParsedQueryClause[],
): boolean {
  if (!sectionText || clauses.length === 0) return false;

  const targetTokens = toWordTokens(sectionText);
  if (targetTokens.length === 0) return false;

  for (const clause of clauses) {
    let clauseMatched = false;

    for (const variantWords of clause.wordVariants) {
      const candidateWindows = findPhraseMatchWindows(targetTokens, variantWords);
      if (candidateWindows.length === 0) continue;

      for (const win of candidateWindows) {
        const windowTokens = targetTokens.slice(
          Math.max(0, win.minIdx - 3),
          Math.min(targetTokens.length, win.maxIdx + 4),
        );

        // Handle "perm" / "p" modifier accuracy around THIS specific occurrence
        if (clause.perm) {
          const hasPerm =
            win.tokenHasPermPrefix ||
            windowTokens.some(
              (t) => t === 'perm' || t === 'permanent' || t === 'p',
            );
          if (!hasPerm) continue;
        } else {
          const prevToken = win.minIdx > 0 ? targetTokens[win.minIdx - 1] : '';
          if (
            win.tokenHasPermPrefix ||
            prevToken === 'perm' ||
            prevToken === 'permanent'
          ) {
            continue;
          }
        }

        // If user typed a quantity like "2 Serpent fin", verify the quantity is nearby
        if (clause.qty) {
          const hasQty = windowTokens.some((t) => t === clause.qty);
          if (!hasQty) continue;
        }

        clauseMatched = true;
        break;
      }

      if (clauseMatched) break;
    }

    if (!clauseMatched) return false;
  }

  return true;
}

// Checks if a channel is readable by the bot and looks like a trading channel
function isReadableTextChannel(
  channel: GuildBasedChannel,
  meId: string,
): boolean {
  if (
    channel.type !== ChannelType.GuildText &&
    channel.type !== ChannelType.GuildAnnouncement &&
    channel.type !== ChannelType.PublicThread &&
    channel.type !== ChannelType.PrivateThread
  ) {
    return false;
  }

  const perms = channel.permissionsFor(meId);
  return Boolean(
    perms?.has([
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.ReadMessageHistory,
    ]),
  );
}

// Finds all trading channels across every server the bot has joined
function getTradingChannels(client: Client) {
  const meId = client.user?.id;
  if (!meId) return [];

  const configuredIds = new Set(
    (process.env.TRADE_CHANNEL_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const explicitChannels: Array<{ channel: any }> = [];
  const fallbackChannels: Array<{ channel: any }> = [];

  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (!isReadableTextChannel(channel, meId)) continue;

      const parentName = channel.parent?.name || '';
      const isConfigured = configuredIds.has(channel.id);
      const isTradeNamed =
        TRADING_CHANNEL_REGEX.test(channel.name) ||
        TRADING_CHANNEL_REGEX.test(parentName);

      if (isConfigured || isTradeNamed) {
        explicitChannels.push({ channel });
      } else if (channel.type === ChannelType.GuildText) {
        fallbackChannels.push({ channel });
      }
    }
  }

  return explicitChannels.length > 0 ? explicitChannels : fallbackChannels;
}

// Converts a Discord Message (including forwarded snapshots) into an IndexedTrade if within 24h
export function indexSingleMessage(message: Message): IndexedTrade | null {
  if (!message.guild || message.author.bot || message.webhookId) return null;

  const cutoff = Date.now() - TRADE_MAX_AGE_MS;
  if (message.createdTimestamp < cutoff) return null;

  const snapshotText = message.messageSnapshots
    ? [...message.messageSnapshots.values()]
        .map((snap) => snap.content?.trim())
        .filter(Boolean)
        .join('\n')
    : '';
  const content = [message.content?.trim(), snapshotText]
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!content) return null;

  const sections = extractTradeSections(content);
  const channelName =
    'name' in message.channel && typeof message.channel.name === 'string'
      ? message.channel.name
      : 'trading';

  const entry: IndexedTrade = {
    messageId: message.id,
    channelId: message.channelId,
    channelName,
    guildId: message.guild.id,
    guildName: message.guild.name,
    guildIconUrl:
      message.guild.iconURL({ size: 256, extension: 'png' }) ||
      DEFAULT_GUILD_ICON_URL,
    authorId: message.author.id,
    authorUsername: message.author.username,
    content,
    createdTimestamp: message.createdTimestamp,
    lfText: sections.lfText,
    offeringText: sections.offeringText,
    expandedFullText: sections.expandedFullText,
    hasLfKeyword: sections.hasLfKeyword,
    hasOfferKeyword: sections.hasOfferKeyword,
  };

  tradeCache.set(message.id, entry);
  return entry;
}

// Removes a deleted message from the in-memory trade cache
export function removeIndexedMessage(messageId: string): void {
  tradeCache.delete(messageId);
}

// Drops any cached messages older than 24 hours
function pruneExpiredTrades(now = Date.now()): void {
  const cutoff = now - TRADE_MAX_AGE_MS;
  for (const [id, trade] of tradeCache.entries()) {
    if (trade.createdTimestamp < cutoff) {
      tradeCache.delete(id);
    }
  }
}

// Fetches up to 24 hours of messages across all trading channels
export async function syncTradesFromChannels(
  client: Client,
  force = false,
): Promise<number> {
  const now = Date.now();
  pruneExpiredTrades(now);

  if (!force && lastSyncTimestamp > 0 && now - lastSyncTimestamp < 15_000) {
    return tradeCache.size;
  }

  if (activeSyncPromise) {
    return activeSyncPromise;
  }

  activeSyncPromise = (async () => {
    try {
      const cutoff = Date.now() - TRADE_MAX_AGE_MS;
      const channels = getTradingChannels(client);

      await Promise.all(
        channels.map(async ({ channel }) => {
          try {
            let beforeId: string | undefined;

            for (let page = 0; page < MAX_FETCH_PAGES_PER_CHANNEL; page++) {
              const batch = await channel.messages.fetch(
                beforeId ? { limit: 100, before: beforeId } : { limit: 100 },
              );
              if (batch.size === 0) break;

              let oldestTs = Infinity;
              let oldestId: string | undefined;

              for (const msg of batch.values()) {
                if (msg.createdTimestamp < oldestTs) {
                  oldestTs = msg.createdTimestamp;
                  oldestId = msg.id;
                }
                if (msg.createdTimestamp >= cutoff) {
                  indexSingleMessage(msg);
                }
              }

              // Stop paginating once we reach messages older than 24 hours or end of channel
              if (batch.size < 100 || oldestTs < cutoff || !oldestId) {
                break;
              }
              beforeId = oldestId;
            }
          } catch (error) {
            console.warn(
              `Could not fetch messages in #${channel.name}:`,
              error instanceof Error ? error.message : String(error),
            );
          }
        }),
      );

      pruneExpiredTrades();

      // Keep cache bounded to newest 25,000 messages within the 24h window
      if (tradeCache.size > 25_000) {
        const sorted = [...tradeCache.values()].sort(
          (a, b) => b.createdTimestamp - a.createdTimestamp,
        );
        tradeCache.clear();
        for (const item of sorted.slice(0, 25_000)) {
          tradeCache.set(item.messageId, item);
        }
      }

      lastSyncTimestamp = Date.now();
      return tradeCache.size;
    } finally {
      activeSyncPromise = null;
    }
  })();

  return activeSyncPromise;
}

// Smart hybrid search: combines strict LF/Offering section extraction with Discord-search-style keyword matching (24h window)
export function searchIndexedTrades(
  query: string,
  mode: SearchMode,
): IndexedTrade[] {
  const now = Date.now();
  pruneExpiredTrades(now);
  const cutoff = now - TRADE_MAX_AGE_MS;

  const clauses = parseSearchQuery(query);
  if (clauses.length === 0) return [];

  const matches: IndexedTrade[] = [];

  for (const trade of tradeCache.values()) {
    if (trade.createdTimestamp < cutoff) continue;

    if (mode === 'lf') {
      // Primary: item matched directly inside the extracted LF section
      if (matchesSectionText(trade.lfText, clauses)) {
        matches.push(trade);
        continue;
      }

      // Hybrid fallback: message contains an LF keyword/emoji + item, and item is NOT claimed by Offering
      if (
        trade.hasLfKeyword &&
        matchesSectionText(trade.expandedFullText, clauses) &&
        !matchesSectionText(trade.offeringText, clauses)
      ) {
        matches.push(trade);
      }
    } else {
      // Primary: item matched directly inside the extracted Offering section
      if (matchesSectionText(trade.offeringText, clauses)) {
        matches.push(trade);
        continue;
      }

      // Hybrid fallback: message contains an Offering keyword/emoji + item, and item is NOT claimed by LF
      if (
        trade.hasOfferKeyword &&
        matchesSectionText(trade.expandedFullText, clauses) &&
        !matchesSectionText(trade.lfText, clauses)
      ) {
        matches.push(trade);
      }
    }
  }

  // Sort strictly by time sent (newest relevant trade first)
  return matches.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
}

// Returns the user's filter terms cleanly for the Tags section (only what the user entered)
function extractUserFilterTags(rawQuery: string): string {
  const cleanedQuery = rawQuery
    .trim()
    .replace(/^(?:l\s*\/?\s*f|looking\s+for|offering|offer|trading)\s*:?\s+/i, '');

  const parts = cleanedQuery
    .split(/[,+\n&]+|\band\b/i)
    .map((p) => p.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts.join(', ') : rawQuery.trim();
}

// Finds the character range [start, end] of the matched query phrase/emoji inside a single line
function findMatchCharRange(
  line: string,
  clauses: ParsedQueryClause[],
): { start: number; end: number } | null {
  for (const clause of clauses) {
    for (const variant of clause.wordVariants) {
      const joined = variant.join('');
      const spaced = variant.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
      const permPrefix = clause.perm ? '(?:perm(?:anent)?\\s+|p\\s+)?' : '';

      // 1) Try matching phrase in plain text (outside Discord <...> tags)
      const phraseRegex = new RegExp(
        `(?<![a-zA-Z0-9_<:])${permPrefix}(?:${spaced}|${joined})(?:s|hat|totem)?(?![a-zA-Z0-9_>])`,
        'gi',
      );
      let m: RegExpExecArray | null;
      while ((m = phraseRegex.exec(line)) !== null) {
        // Skip if match index falls inside a <...> tag
        const before = line.slice(0, m.index);
        if (before.lastIndexOf('<') > before.lastIndexOf('>')) continue;
        return { start: m.index, end: m.index + m[0].length };
      }

      // 2) Try matching custom emoji name (e.g. <:dark_beard_hat:123> or <:kltoy:123>)
      const emojiRegex = /<a?:([a-zA-Z0-9_]+):\d+>/g;
      while ((m = emojiRegex.exec(line)) !== null) {
        const splitWords = toWordTokens(splitEmojiName(m[1]));
        const allFound = variant.every((vw) =>
          splitWords.some((ew) => wordsExactMatch(vw, ew)),
        );
        const joinedFound = splitWords.some((ew) =>
          wordsExactMatch(joined, ew.replace(/^kl/, '')),
        );
        if (allFound || joinedFound) {
          return { start: m.index, end: m.index + m[0].length };
        }
      }

      // 3) Fallback: locate the first matching query word in plain text
      for (const word of variant) {
        const safeWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const wordRegex = new RegExp(`(?<![a-zA-Z0-9_<:])${safeWord}s?(?![a-zA-Z0-9_>])`, 'gi');
        while ((m = wordRegex.exec(line)) !== null) {
          const before = line.slice(0, m.index);
          if (before.lastIndexOf('<') > before.lastIndexOf('>')) continue;
          return { start: m.index, end: m.index + m[0].length };
        }
      }
    }
  }
  return null;
}

// Trims a long line into a <= 160 char window centered around [matchStart, matchEnd] without breaking emojis
function sliceCenteredWindow(
  line: string,
  matchRange: { start: number; end: number } | null,
  maxLen = 160,
): string {
  if (line.length <= maxLen) return line;
  if (!matchRange) {
    return `${line.slice(0, maxLen - 3).trimEnd()}...`;
  }

  const matchLen = matchRange.end - matchRange.start;
  const sideBudget = Math.max(20, Math.floor((maxLen - matchLen - 6) / 2));
  let start = Math.max(0, matchRange.start - sideBudget);
  let end = Math.min(line.length, matchRange.end + sideBudget);

  // If one side hit the edge, give remaining budget to the other side
  if (start === 0) {
    end = Math.min(line.length, maxLen - 3);
  } else if (end === line.length) {
    start = Math.max(0, line.length - (maxLen - 3));
  }

  // Snap start forward to a clean word boundary and avoid slicing inside <...> Discord tokens
  if (start > 0) {
    const openAngle = line.lastIndexOf('<', start);
    const closeAngle = line.lastIndexOf('>', start);
    if (openAngle > closeAngle) {
      start = openAngle;
    } else {
      const nextSpace = line.indexOf(' ', start);
      if (nextSpace !== -1 && nextSpace < matchRange.start) {
        start = nextSpace + 1;
      }
    }
  }

  // Snap end backward to a clean word boundary and avoid slicing inside <...> Discord tokens
  if (end < line.length) {
    const openAngle = line.lastIndexOf('<', end);
    const closeAngle = line.lastIndexOf('>', end);
    if (openAngle > closeAngle) {
      const tokenEnd = line.indexOf('>', end);
      end = tokenEnd !== -1 ? tokenEnd + 1 : openAngle;
    } else {
      const prevSpace = line.lastIndexOf(' ', end);
      if (prevSpace > matchRange.end) {
        end = prevSpace;
      }
    }
  }

  const prefix = start > 0 ? '... ' : '';
  const suffix = end < line.length ? ' ...' : '';
  return `${prefix}${line.slice(start, end).trim()}${suffix}`;
}

// Strips Discord markdown (#, -#, >, *, _, ~~, `, ||) and normalizes fancy fonts into clean plain text
function normalizeSnippetToPlainText(rawLine: string): string {
  const segments = rawLine.split(/(<a?:[a-zA-Z0-9_]+:\d+>|<@!?\d+>|<#\d+>|<t:\d+:\w>)/g);

  return segments
    .map((seg, idx) => {
      if (!seg) return '';
      if (seg.startsWith('<') && seg.endsWith('>')) return seg;

      let plain = seg.normalize('NFKC');
      if (idx === 0) {
        // Remove leading Discord block prefixes (#, ##, ###, -#, >, bullets)
        plain = plain.replace(/^\s*(?:-#\s+|#{1,3}\s+|>\s*|[-•]\s+)/g, '');
      }
      // Remove inline Discord formatting symbols without touching normal punctuation
      plain = plain
        .replace(/(\*\*|__|~~|\|\||```|`)/g, '')
        .replace(/(^|\s)[*_]+(?=\S)/g, '$1')
        .replace(/(?<=\S)[*_]+(?=\s|$|[.,!?;:])/g, '');
      return plain;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

// Bolds the matched search keywords (tags) inside the normalized snippet without breaking Discord <...> tags
function boldMatchedKeywords(snippet: string, clauses: ParsedQueryClause[]): string {
  const clean = normalizeSnippetToPlainText(snippet);

  const phrasePatterns: string[] = [];
  const emojiMatchers: Array<{ variant: string[]; joined: string }> = [];

  for (const clause of clauses) {
    for (const variant of clause.wordVariants) {
      const escapedWords = variant.map((w) =>
        w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      );
      const joined = variant.join('').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const permOpt = clause.perm ? '(?:perm(?:anent)?\\s+)?' : '';

      if (escapedWords.length > 1) {
        phrasePatterns.push(`${permOpt}${escapedWords.join('\\s+')}s?`);
      }
      phrasePatterns.push(`${permOpt}${joined}s?`);
      if (escapedWords.length === 1) {
        phrasePatterns.push(`${permOpt}${escapedWords[0]}s?`);
      }
      emojiMatchers.push({ variant, joined: variant.join('') });
    }
  }

  // Sort longer phrases first (e.g. "dark beard" before "dark")
  const uniquePatterns = [...new Set(phrasePatterns)].sort(
    (a, b) => b.length - a.length,
  );
  const wordRegex =
    uniquePatterns.length > 0
      ? new RegExp(`(?<![a-zA-Z0-9_])(?:${uniquePatterns.join('|')})(?![a-zA-Z0-9_])`, 'gi')
      : null;

  // Split by Discord <...> tags so plain text and custom emojis are bolded safely
  const segments = clean.split(/(<a?:[a-zA-Z0-9_]+:\d+>|<@!?\d+>|<#\d+>|<t:\d+:\w>)/g);

  return segments
    .map((seg) => {
      if (!seg) return '';
      if (seg.startsWith('<') && seg.endsWith('>')) {
        const emojiMatch = /^<a?:([a-zA-Z0-9_]+):\d+>$/.exec(seg);
        if (emojiMatch) {
          const ewList = toWordTokens(splitEmojiName(emojiMatch[1]));
          const matchesEmoji = emojiMatchers.some(
            ({ variant, joined }) =>
              variant.every((vw) => ewList.some((ew) => wordsExactMatch(vw, ew))) ||
              ewList.some((ew) => wordsExactMatch(joined, ew.replace(/^kl/, ''))),
          );
          if (matchesEmoji) return `**${seg}**`;
        }
        return seg;
      }

      return wordRegex ? seg.replace(wordRegex, (match) => `**${match}**`) : seg;
    })
    .join('');
}

// Extracts user-filter tags and a bolded, match-centered relevant snippet from the trade
export function extractTradeTagsAndSnippet(
  trade: IndexedTrade,
  query: string,
  mode: SearchMode,
): { tagsText: string; relevantPart: string } {
  const tagsText = extractUserFilterTags(query);
  const clauses = parseSearchQuery(query);

  // Deduplicate repeated spam lines while preserving order
  const uniqueLines: string[] = [];
  const seenLineKeys = new Set<string>();
  for (const line of trade.content.split(/\r?\n/)) {
    const collapsed = line.replace(/\s+/g, ' ').trim();
    if (!collapsed) continue;
    const key = collapsed.toLowerCase();
    if (!seenLineKeys.has(key)) {
      seenLineKeys.add(key);
      uniqueLines.push(collapsed);
    }
  }

  // Track which section (lf/offer) each line belongs to across the message
  let currentMode: 'unknown' | 'lf' | 'offer' = 'unknown';
  const scoredLines = uniqueLines.map((line, idx) => {
    const tokens = tokenizeTradeMessage(line).tokens;
    const lineSec = extractTradeSections(line);
    const sectionText =
      mode === 'lf'
        ? lineSec.lfText || lineSec.expandedFullText
        : lineSec.offeringText || lineSec.expandedFullText;

    // Count how many query clauses match this line (preferring lines in the target mode)
    const fullClauseHits = clauses.filter((c) =>
      matchesSectionText(lineSec.expandedFullText, [c]),
    ).length;
    const modeClauseHits = clauses.filter((c) =>
      matchesSectionText(sectionText, [c]),
    ).length;

    const inTargetMode =
      (mode === 'lf' && (currentMode === 'lf' || lineSec.hasLfKeyword)) ||
      (mode === 'offering' && (currentMode === 'offer' || lineSec.hasOfferKeyword));

    for (const tok of tokens) {
      if (tok.kind === 'lf_marker' || tok.kind === 'transition_marker') currentMode = 'lf';
      if (tok.kind === 'offer_marker') currentMode = 'offer';
    }

    return {
      idx,
      line,
      score:
        modeClauseHits * 10 +
        fullClauseHits * 5 +
        (inTargetMode && fullClauseHits > 0 ? 4 : 0),
    };
  });

  // Pick the highest-scoring line that actually contains the matched query words
  const best = scoredLines
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.idx - b.idx)[0];

  let rawSnippet = '';
  if (best) {
    const cleanBest = normalizeSnippetToPlainText(best.line);
    const cleanPrev = best.idx > 0 ? normalizeSnippetToPlainText(uniqueLines[best.idx - 1]) : '';
    const hasShortHeader =
      cleanPrev.length > 0 &&
      cleanPrev.length <= 24 &&
      cleanBest.length + cleanPrev.length + 1 <= 160;
    rawSnippet = hasShortHeader ? `${cleanPrev} ${cleanBest}` : cleanBest;
  } else {
    rawSnippet =
      uniqueLines.map(normalizeSnippetToPlainText).filter(Boolean).join(' ') ||
      normalizeSnippetToPlainText(trade.content);
  }

  const singleLine = rawSnippet.replace(/\s+/g, ' ').trim();
  const matchRange = findMatchCharRange(singleLine, clauses);
  const centeredWindow = sliceCenteredWindow(singleLine, matchRange, 160);
  const relevantPart = boldMatchedKeywords(centeredWindow, clauses);

  return {
    tagsText,
    relevantPart,
  };
}

export function getCachedTradeCount(): number {
  return tradeCache.size;
}

// Summarizes raw word hits in cache when a search finds 0 matches for console diagnostics
export function diagnoseSearchMisses(
  query: string,
  mode: SearchMode,
): Record<string, unknown> {
  const words = toWordTokens(query).filter(
    (w) => w.length >= 2 && !/^\d+$/.test(w) && w !== 'perm',
  );
  const rawSamples: Array<Record<string, unknown>> = [];
  let rawHitCount = 0;

  for (const trade of tradeCache.values()) {
    const lowerFull = trade.expandedFullText.toLowerCase();
    if (words.length > 0 && words.every((w) => lowerFull.includes(w))) {
      rawHitCount += 1;
      if (rawSamples.length < 3) {
        rawSamples.push({
          author: trade.authorUsername,
          channel: trade.channelName,
          hasLf: trade.hasLfKeyword,
          hasOffer: trade.hasOfferKeyword,
          lfPreview: trade.lfText.slice(0, 80),
          offerPreview: trade.offeringText.slice(0, 80),
          rawPreview: trade.content.slice(0, 100),
        });
      }
    }
  }

  return {
    query,
    mode,
    cachedTrades: tradeCache.size,
    rawHitCount,
    rawSamples,
  };
}
