import type { GuildBasedChannel, Interaction } from 'discord.js';

// Logs detailed step-by-step diagnostics for /search trade so issues are easy to trace
export function logSearchDiag(
  stage: string,
  details: Record<string, unknown> = {},
): void {
  const time = new Date().toISOString();
  console.log(`[SearchDiag ${time}] ${stage}`, JSON.stringify(details));
}

// Safely inspects channel permissions for the bot without throwing
export function describeBotChannelAccess(interaction: Interaction): Record<string, unknown> {
  const guild = interaction.guild;
  const channel = interaction.channel as GuildBasedChannel | null;
  const me = guild?.members.me;

  if (!guild || !channel || !me || typeof channel.permissionsFor !== 'function') {
    return {
      inGuild: Boolean(guild),
      channelId: interaction.channelId ?? null,
      hasChannelObj: Boolean(channel),
      hasMeMember: Boolean(me),
    };
  }

  const perms = channel.permissionsFor(me);
  return {
    guildId: guild.id,
    guildName: guild.name,
    channelId: channel.id,
    channelName: channel.name,
    viewChannel: perms?.has('ViewChannel') ?? false,
    sendMessages: perms?.has('SendMessages') ?? false,
    embedLinks: perms?.has('EmbedLinks') ?? false,
    readMessageHistory: perms?.has('ReadMessageHistory') ?? false,
  };
}

// Formats Discord REST / runtime errors with code, HTTP status, method, and URL
export function logSearchError(
  stage: string,
  error: unknown,
  context: Record<string, unknown> = {},
): void {
  const errObj = error as {
    name?: string;
    message?: string;
    code?: number | string;
    status?: number;
    method?: string;
    url?: string;
    rawError?: unknown;
  };

  console.error(
    `[SearchDiag ERROR] ${stage}`,
    JSON.stringify({
      ...context,
      name: errObj?.name ?? typeof error,
      message: errObj?.message ?? String(error),
      code: errObj?.code ?? null,
      status: errObj?.status ?? null,
      method: errObj?.method ?? null,
      url: errObj?.url ?? null,
      rawError: errObj?.rawError ?? null,
    }),
  );
}
