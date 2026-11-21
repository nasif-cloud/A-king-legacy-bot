import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { valueCommandData } from './command.js';

interface PartialGuild {
  id: string;
  name: string;
}

export async function syncSlashCommands(
  token: string,
  clientId: string,
  guildId?: string,
): Promise<string[]> {
  const rest = new REST().setToken(token);
  const commands = [valueCommandData.toJSON()];
  const messages: string[] = [];

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands,
    });
    messages.push(`Registered /value command to guild ${guildId}.`);
    return messages;
  }

  const guilds = (await rest.get(Routes.userGuilds())) as PartialGuild[];

  if (guilds.length > 0 && guilds.length <= 20) {
    for (const guild of guilds) {
      await rest.put(Routes.applicationGuildCommands(clientId, guild.id), {
        body: commands,
      });
      messages.push(`Registered /value command to server "${guild.name}" (${guild.id}).`);
    }
    // Clear global commands to avoid duplicate /value entries or stale cached options
    await rest.put(Routes.applicationCommands(clientId), {
      body: [],
    });
    messages.push('Cleared global command cache so static choices take effect immediately.');
  } else {
    await rest.put(Routes.applicationCommands(clientId), {
      body: commands,
    });
    messages.push('Registered /value command globally.');
  }

  return messages;
}

async function main(): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || !clientId) {
    console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment variables.');
    process.exit(1);
  }

  const logs = await syncSlashCommands(token, clientId, guildId);
  for (const line of logs) {
    console.log(line);
  }
}

const isCliEntry = process.argv[1]?.endsWith('deploy-commands.ts');
if (isCliEntry) {
  main().catch((error) => {
    console.error('Failed to deploy slash commands:', error);
    process.exit(1);
  });
}
