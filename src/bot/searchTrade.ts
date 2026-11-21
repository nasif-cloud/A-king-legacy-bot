import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  ContainerBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionsBitField,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThumbnailBuilder,
  type Guild,
  type Message,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import {
  diagnoseSearchMisses,
  extractTradeTagsAndSnippet,
  getCachedTradeCount,
  searchIndexedTrades,
  syncTradesFromChannels,
  type IndexedTrade,
  type SearchMode,
} from './tradeMatcher.js';
import {
  describeBotChannelAccess,
  logSearchDiag,
  logSearchError,
} from './diagnostics/searchDiagnostics.js';

// Custom Discord emojis provided for the /search trade interface
const LF_EMOJI = { id: '1573684805390831737', name: 'lf' };
const LOADING_EMOJI = '<a:loading:1573681327096594463>';
const NEXT_EMOJI = { id: '1573694024500519043', name: 'nextbutton' };
const PREV_EMOJI = { id: '1573694038698098778', name: 'previousbutton' };
const JUMP_EMOJI = { id: '1573692834845036594', name: 'underhand' };
const RESPOND_EMOJI = { id: '1573698970364940515', name: 'talk' };
const FALLBACK_AVATAR_URL = 'https://cdn.discordapp.com/embed/avatars/0.png';

// Ephemeral interaction tokens last 15 minutes; mark embeds expired at 14 minutes
const SESSION_TTL_MS = 14 * 60 * 1000;
const REPLY_COOLDOWN_MS = 15 * 1000;

interface SearchSession {
  id: string;
  userId: string;
  mode: SearchMode | null;
  query: string;
  results: IndexedTrade[];
  page: number;
  expired: boolean;
  message?: Message;
  lastInteraction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | StringSelectMenuInteraction
    | ModalSubmitInteraction;
  timeoutHandle?: NodeJS.Timeout;
}

const searchSessions = new Map<string, SearchSession>();
const replyCooldowns = new Map<string, number>();

// Registers the "/trade search" slash command with zero options
export const searchCommandData = new SlashCommandBuilder()
  .setName('trade')
  .setDescription('search for a trade across trading channels')
  .addSubcommand((sub) =>
    sub
      .setName('search')
      .setDescription('search for a trade across trading channels'),
  );

// Creates a short unique ID for component customIds
function makeSessionId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// Gives an owning sibling instance time to reply before reporting an expired session
async function replySessionExpiredIfUnclaimed(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  ownedByThisInstance: boolean,
): Promise<void> {
  if (!ownedByThisInstance) {
    await new Promise((resolve) => setTimeout(resolve, 1800));
  }
  await interaction.reply({
    content: 'This search has expired, run /trade search again',
    flags: MessageFlags.Ephemeral,
  });
}

// Safely strips reserved words ("discord", "clyde") and trims webhook usernames
function sanitizeWebhookUsername(rawName: string): string {
  const cleaned = rawName
    .replace(/discord/gi, 'd1scord')
    .replace(/clyde/gi, 'user')
    .replace(/```/g, '')
    .trim();
  if (!cleaned) return 'Trader';
  return cleaned.slice(0, 80);
}

// Blocks Discord TOS violations, invites, external links, mass pings, and spam
function validateTradeReplyContent(rawText: string): {
  ok: boolean;
  cleaned?: string;
  reason?: string;
} {
  const cleaned = rawText.trim();
  if (!cleaned) {
    return { ok: false, reason: 'Message cannot be empty' };
  }
  if (cleaned.length > 1000) {
    return { ok: false, reason: 'Message must be 1000 characters or fewer' };
  }

  // Block mass pings and role mentions
  if (/@everyone|@here|<@&\d+>/i.test(cleaned)) {
    return {
      ok: false,
      reason: 'Mass mentions (@everyone, @here, or roles) are not allowed',
    };
  }

  // Block Discord invite links and external URLs to prevent phishing/TOS abuse
  if (/(https?:\/\/|discord\.gg\/|discord\.com\/invite\/|discordapp\.com\/invite\/)/i.test(cleaned)) {
    return {
      ok: false,
      reason: 'Links and invite URLs cannot be sent through trade replies',
    };
  }

  // Block severe harassment, slurs, self-harm, and scam keywords
  const blockedPatterns = [
    /\b(kys|kill\s*yourself)\b/i,
    /\b(nigger|nigga|faggot|retard|tranny)\b/i,
    /\b(free\s*nitro|steam\s*gift|token\s*grab|grabify|iplogger)\b/i,
    /\b(cp|csam|dox+ing)\b/i,
  ];
  if (blockedPatterns.some((re) => re.test(cleaned))) {
    return {
      ok: false,
      reason: 'Message blocked because it violates Discord Terms of Service',
    };
  }

  // Prevent excessive combining diacritics (Zalgo text)
  const combiningMarks = cleaned.match(/[\u0300-\u036f]/g);
  if (combiningMarks && combiningMarks.length > 20) {
    return { ok: false, reason: 'Excessive special characters are not allowed' };
  }

  return { ok: true, cleaned };
}

// Builds the initial "/search trade" Components V2 container; swaps description to loading text only while searching
function buildSearchPromptContainer(
  client: Client,
  session: SearchSession,
  isLoading = false,
): ContainerBuilder {
  const botAvatar =
    client.user?.displayAvatarURL({ size: 256, extension: 'png' }) ||
    FALLBACK_AVATAR_URL;

  const bodyText =
    isLoading && !session.expired
      ? `### loading trades ${LOADING_EMOJI}`
      : 'click the __input trade__ button to input the trade you\'re looking for';

  const container = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('## 🔍 Search for a specific trade'),
    )
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(bodyText))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(botAvatar)),
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addActionRowComponents(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`st_lf:${session.id}`)
          .setLabel('input trade (LF)')
          .setEmoji(LF_EMOJI)
          .setStyle(ButtonStyle.Success)
          .setDisabled(session.expired || isLoading),
        new ButtonBuilder()
          .setCustomId(`st_off:${session.id}`)
          .setLabel('input trade (offering...)')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(session.expired || isLoading),
      ),
    );

  // When button-based containers expire, clear footer status and show "expired"
  if (session.expired) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('-# expired'),
    );
  }

  return container;
}

// Builds the paginated trade results Components V2 container (matches image 2)
function buildTradeResultContainer(session: SearchSession): ContainerBuilder {
  const total = session.results.length;
  const page = Math.max(0, Math.min(session.page, total - 1));
  const trade = session.results[page];
  const relativeUnix = Math.floor(trade.createdTimestamp / 1000);

  const options: StringSelectMenuOptionBuilder[] = [];

  if (page < total - 1) {
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel('next trade')
        .setValue('next')
        .setEmoji(NEXT_EMOJI),
    );
  }

  if (page > 0) {
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel('previous trade')
        .setValue('prev')
        .setEmoji(PREV_EMOJI),
    );
  }

  options.push(
    new StringSelectMenuOptionBuilder()
      .setLabel('jump to message')
      .setValue('jump')
      .setEmoji(JUMP_EMOJI),
    new StringSelectMenuOptionBuilder()
      .setLabel('respond to message')
      .setValue('respond')
      .setEmoji(RESPOND_EMOJI),
  );

  const { tagsText, relevantPart } = extractTradeTagsAndSnippet(
    trade,
    session.query,
    session.mode ?? 'lf',
  );
  const safeContent =
    trade.content.length > 1800
      ? `${trade.content.slice(0, 1797)}...`
      : trade.content || '(no message text)';

  const container = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# page ${page + 1} of ${total}`),
    )
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## <t:${relativeUnix}:R> - From\n## <@${trade.authorId}> [${trade.authorUsername}]`,
          ),
        )
        .setThumbnailAccessory(
          new ThumbnailBuilder().setURL(trade.guildIconUrl || FALLBACK_AVATAR_URL),
        ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(safeContent))
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**🏷️ __Tags__**\n${tagsText}\n\n**📌 __Relevant part__**\n${relevantPart}`,
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addActionRowComponents(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          // Include current page in customId so Discord clears the previous menu selection on page change
          .setCustomId(`st_act:${session.id}:${page}`)
          .setPlaceholder('actions')
          .setDisabled(session.expired)
          .addOptions(options),
      ),
    );

  if (session.expired) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('-# expired'),
    );
  }

  return container;
}

// Builds a clean "no matching trades" container with retry buttons
function buildNoResultsContainer(
  client: Client,
  session: SearchSession,
): ContainerBuilder {
  const botAvatar =
    client.user?.displayAvatarURL({ size: 256, extension: 'png' }) ||
    FALLBACK_AVATAR_URL;
  const modeLabel = session.mode === 'lf' ? 'LF' : 'Offering';

  const container = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('## 🔍 No matching trades found'),
    )
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `No recent trades matched **${session.query}** in **${modeLabel}**\nTry a different spelling or click below to search again`,
          ),
        )
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(botAvatar)),
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addActionRowComponents(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`st_lf:${session.id}`)
          .setLabel('input trade (LF)')
          .setEmoji(LF_EMOJI)
          .setStyle(ButtonStyle.Success)
          .setDisabled(session.expired),
        new ButtonBuilder()
          .setCustomId(`st_off:${session.id}`)
          .setLabel('input trade (offering...)')
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

// Resets the 14-minute expiration timer and updates footer to "expired" on timeout
function refreshSessionTimeout(client: Client, session: SearchSession): void {
  if (session.timeoutHandle) {
    clearTimeout(session.timeoutHandle);
  }

  session.timeoutHandle = setTimeout(async () => {
    session.expired = true;
    searchSessions.delete(session.id);

    try {
      const container =
        session.results.length > 0
          ? buildTradeResultContainer(session)
          : session.mode
            ? buildNoResultsContainer(client, session)
            : buildSearchPromptContainer(client, session);

      try {
        await session.lastInteraction.editReply({
          components: [container],
          flags: MessageFlags.IsComponentsV2,
        });
      } catch {
        if (session.message) {
          await session.message.edit({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
          });
        }
      }
    } catch (err) {
      logSearchError('session_expire_edit_failed', err, { sessionId: session.id });
    }
  }, SESSION_TTL_MS);
}

// Checks whether a user is a member of a specific Discord server
async function isUserInGuild(guild: Guild, userId: string): Promise<boolean> {
  try {
    await guild.members.fetch(userId);
    return true;
  } catch {
    return false;
  }
}

// Finds an existing invite or creates a temporary invite link for a guild
async function getOrCreateGuildInvite(
  guild: Guild,
  channelId: string,
): Promise<string | null> {
  if (guild.vanityURLCode) {
    return `https://discord.gg/${guild.vanityURLCode}`;
  }

  try {
    const channel = await guild.channels.fetch(channelId);
    if (
      channel &&
      (channel.type === ChannelType.GuildText ||
        channel.type === ChannelType.GuildAnnouncement)
    ) {
      const me = guild.members.me;
      if (
        me &&
        channel
          .permissionsFor(me)
          ?.has(PermissionsBitField.Flags.CreateInstantInvite)
      ) {
        const invite = await channel.createInvite({
          maxAge: 86400,
          maxUses: 0,
          unique: false,
          reason: 'User jumped to trade message from /search trade',
        });
        return invite.url;
      }
    }
  } catch {
    // Fall back to existing guild invites below
  }

  try {
    const me = guild.members.me;
    if (me?.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      const invites = await guild.invites.fetch();
      const first = invites.first();
      if (first) return first.url;
    }
  } catch {
    // No invite permissions available
  }

  return null;
}

// Handles "/trade search" command execution
export async function handleSearchCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (interaction.options.getSubcommand() !== 'search') return;

  const session: SearchSession = {
    id: makeSessionId(),
    userId: interaction.user.id,
    mode: null,
    query: '',
    results: [],
    page: 0,
    expired: false,
    lastInteraction: interaction,
  };

  searchSessions.set(session.id, session);
  refreshSessionTimeout(interaction.client, session);

  logSearchDiag('command_search_trade', {
    sessionId: session.id,
    userId: interaction.user.id,
    cachedTrades: getCachedTradeCount(),
    access: describeBotChannelAccess(interaction),
  });

  // Send the search container publicly to the chat; controls stay locked to the command author
  await interaction.reply({
    components: [buildSearchPromptContainer(interaction.client, session)],
    flags: MessageFlags.IsComponentsV2,
  });
  session.message = await interaction.fetchReply();

  // Warm up trade messages in the background without altering the prompt text
  void syncTradesFromChannels(interaction.client);
}

// Handles clicking "input trade (LF)" or "input trade (offering...)" buttons
export async function handleSearchButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const [prefix, sessionId] = interaction.customId.split(':');
  if (prefix !== 'st_lf' && prefix !== 'st_off') return;

  logSearchDiag('button_clicked', {
    prefix,
    sessionId,
    userId: interaction.user.id,
    messageId: interaction.message.id,
    channelId: interaction.channelId,
  });

  const session = searchSessions.get(sessionId);
  if (!session || session.expired) {
    logSearchDiag('button_session_missing_or_expired', { sessionId, ownedLocally: Boolean(session) });
    await replySessionExpiredIfUnclaimed(interaction, Boolean(session));
    return;
  }

  if (session.userId !== interaction.user.id) {
    await interaction.reply({
      content: `Only <@${session.userId}> can use these controls`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const mode: SearchMode = prefix === 'st_lf' ? 'lf' : 'offering';
  session.lastInteraction = interaction;
  refreshSessionTimeout(interaction.client, session);

  // Build Discord modal form with 1 option ("type item" + description)
  const modal = new ModalBuilder()
    .setCustomId(`st_modal:${session.id}:${mode}`)
    .setTitle(mode === 'lf' ? 'Search Trade (LF)' : 'Search Trade (Offering)')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('type item')
        .setDescription('ex. Perm Erebus, 2 Serpent fin')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('trade_query')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(200),
        ),
    );

  await interaction.showModal(modal);
}

// Handles submitting either the search modal or the "respond to message" modal
export async function handleSearchModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const [prefix, sessionId, extra] = interaction.customId.split(':');

  // 1) Handle trade search modal submission
  if (prefix === 'st_modal') {
    const session = searchSessions.get(sessionId);
    if (!session || session.expired || session.userId !== interaction.user.id) {
      await replySessionExpiredIfUnclaimed(interaction, Boolean(session));
      return;
    }

    const mode: SearchMode = extra === 'lf' ? 'lf' : 'offering';
    const query = interaction.fields.getTextInputValue('trade_query').trim();

    logSearchDiag('modal_submit_start', {
      sessionId,
      mode,
      query,
      isFromMessage: interaction.isFromMessage(),
      channelId: interaction.channelId,
      messageId: interaction.message?.id ?? null,
    });

    await interaction.deferUpdate();
    session.lastInteraction = interaction;
    session.mode = mode;
    session.query = query;
    session.page = 0;
    refreshSessionTimeout(interaction.client, session);

    // Replace description with loading indicator while syncing & searching trades
    try {
      await interaction.editReply({
        components: [buildSearchPromptContainer(interaction.client, session, true)],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch {
      // Proceed to search even if interim loading edit fails
    }

    // Ensure channel messages have finished indexing at least once before searching
    if (getCachedTradeCount() === 0) {
      await syncTradesFromChannels(interaction.client, true);
    } else {
      await syncTradesFromChannels(interaction.client, false);
    }

    const matches = searchIndexedTrades(query, mode);
    session.results = matches;

    logSearchDiag('modal_submit_results', {
      sessionId,
      mode,
      query,
      cachedTrades: getCachedTradeCount(),
      matchCount: matches.length,
    });
    if (matches.length === 0) {
      logSearchDiag('modal_submit_zero_matches', diagnoseSearchMisses(query, mode));
    }

    const nextContainer =
      matches.length > 0
        ? buildTradeResultContainer(session)
        : buildNoResultsContainer(interaction.client, session);

    // Always use editReply (interaction webhook) so updates succeed even without ViewChannel access
    try {
      await interaction.editReply({
        components: [nextContainer],
        flags: MessageFlags.IsComponentsV2,
      });
      logSearchDiag('modal_submit_editReply_ok', {
        sessionId,
        matchCount: matches.length,
      });
    } catch (err) {
      logSearchError('modal_submit_editReply_failed', err, {
        sessionId,
        channelId: interaction.channelId,
      });
      throw err;
    }
    return;
  }

  // 2) Handle "respond to message" modal submission
  if (prefix === 'st_reply') {
    const session = searchSessions.get(sessionId);
    const tradeMessageId = extra;
    const trade = session?.results.find((t) => t.messageId === tradeMessageId);

    if (!session || session.expired || !trade) {
      await replySessionExpiredIfUnclaimed(interaction, Boolean(session));
      return;
    }

    const now = Date.now();
    const lastReply = replyCooldowns.get(interaction.user.id) ?? 0;
    if (now - lastReply < REPLY_COOLDOWN_MS) {
      const waitSec = Math.ceil((REPLY_COOLDOWN_MS - (now - lastReply)) / 1000);
      await interaction.reply({
        content: `Please wait ${waitSec}s before sending another reply`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const rawReply = interaction.fields.getTextInputValue('reply_message');
    const validation = validateTradeReplyContent(rawReply);
    if (!validation.ok || !validation.cleaned) {
      await interaction.reply({
        content: validation.reason || 'Invalid message',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const guild = await interaction.client.guilds.fetch(trade.guildId);
      const channel = await guild.channels.fetch(trade.channelId);
      if (
        !channel ||
        (channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.GuildAnnouncement)
      ) {
        await interaction.editReply({
          content: 'That trading channel is no longer available',
        });
        return;
      }

      // Check if sender can be pinged in the target guild
      const senderInGuild = await isUserInGuild(guild, interaction.user.id);
      const footerLine = senderInGuild
        ? `-# sent by <@${interaction.user.id}>`
        : `-# sent by ${interaction.user.username}`;

      const jumpUrl = `https://discord.com/channels/${trade.guildId}/${trade.channelId}/${trade.messageId}`;
      const finalContent = `-# Replying to <@${trade.authorId}> ([trade](${jumpUrl}))\n${validation.cleaned}\n${footerLine}`;

      const me = guild.members.me;
      const canManageWebhooks = Boolean(
        me &&
          channel
            .permissionsFor(me)
            ?.has(PermissionsBitField.Flags.ManageWebhooks),
      );

      if (canManageWebhooks) {
        // Reuse our bot-owned webhook in the channel or create one so message uses user's name & avatar
        const webhooks = await channel.fetchWebhooks();
        let webhook = webhooks.find(
          (w) => w.owner?.id === interaction.client.user?.id,
        );
        if (!webhook) {
          webhook = await channel.createWebhook({
            name: 'King Legacy Trade Reply',
          });
        }

        await webhook.send({
          content: finalContent,
          username: sanitizeWebhookUsername(
            interaction.user.displayName || interaction.user.username,
          ),
          avatarURL: interaction.user.displayAvatarURL({
            size: 256,
            extension: 'png',
          }),
          allowedMentions: {
            parse: [],
            users: [trade.authorId],
          },
        });
      } else {
        // Fallback if ManageWebhooks isn't granted in that channel
        const targetMsg = await channel.messages.fetch(trade.messageId);
        await targetMsg.reply({
          content: `${validation.cleaned}\n${footerLine}`,
          allowedMentions: {
            parse: [],
            users: [trade.authorId],
          },
        });
      }

      replyCooldowns.set(interaction.user.id, now);
      await interaction.editReply({
        content: `Sent your reply to <@${trade.authorId}> in #${trade.channelName}`,
      });
    } catch (error) {
      console.error('Failed to send trade reply:', error);
      await interaction.editReply({
        content:
          'Could not send reply to that trading channel due to missing permissions or deleted message',
      });
    }
  }
}

// Handles selecting an option from the "actions" dropdown on a trade result
export async function handleSearchSelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const [prefix, sessionId] = interaction.customId.split(':');
  if (prefix !== 'st_act') return;

  const session = searchSessions.get(sessionId);
  if (!session || session.expired || session.results.length === 0) {
    await replySessionExpiredIfUnclaimed(interaction, Boolean(session));
    return;
  }

  if (session.userId !== interaction.user.id) {
    await interaction.reply({
      content: `Only <@${session.userId}> can use these controls`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  session.lastInteraction = interaction;
  refreshSessionTimeout(interaction.client, session);

  const action = interaction.values[0];
  const trade = session.results[session.page];

  logSearchDiag('select_action', {
    sessionId,
    customId: interaction.customId,
    action,
    currentPage: session.page,
    totalPages: session.results.length,
    channelId: interaction.channelId,
  });

  if (action === 'next' || action === 'prev') {
    if (action === 'next' && session.page < session.results.length - 1) {
      session.page += 1;
    } else if (action === 'prev' && session.page > 0) {
      session.page -= 1;
    }

    try {
      await interaction.update({
        components: [buildTradeResultContainer(session)],
        flags: MessageFlags.IsComponentsV2,
      });
      logSearchDiag('select_page_update_ok', {
        sessionId,
        action,
        newPage: session.page,
      });
    } catch (err) {
      logSearchError('select_page_update_failed', err, {
        sessionId,
        action,
        newPage: session.page,
      });
      throw err;
    }
    return;
  }

  if (action === 'jump') {
    try {
      const guild = await interaction.client.guilds.fetch(trade.guildId);
      const inGuild = await isUserInGuild(guild, interaction.user.id);

      if (inGuild) {
        const jumpUrl = `https://discord.com/channels/${trade.guildId}/${trade.channelId}/${trade.messageId}`;
        await interaction.reply({
          content: `Jump to trade message: ${jumpUrl}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const inviteUrl = await getOrCreateGuildInvite(guild, trade.channelId);
      if (inviteUrl) {
        await interaction.reply({
          content: `Not in the server, join first? \n${inviteUrl}`,
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content:
            'Not in the server, and I do not have permission to create an invite link',
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch {
      await interaction.reply({
        content: 'Could not reach that server anymore',
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  if (action === 'respond') {
    const modal = new ModalBuilder()
      .setCustomId(`st_reply:${session.id}:${trade.messageId}`)
      .setTitle(`Reply to ${trade.authorUsername}`.slice(0, 45))
      .addLabelComponents(
        new LabelBuilder()
          .setLabel('your message')
          .setDescription('Follow Discord TOS (no links, invites, or mass pings)')
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId('reply_message')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setMaxLength(1000),
          ),
      );

    await interaction.showModal(modal);
  }
}
