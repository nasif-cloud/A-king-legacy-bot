import 'dotenv/config';
import http from 'node:http';
import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { handleValueAutocomplete, handleValueCommand } from './command.js';
import { syncSlashCommands } from './deploy-commands.js';

const token = process.env.DISCORD_TOKEN?.trim();

if (!token) {
  console.error('Missing DISCORD_TOKEN in environment variables.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Ready! Logged in as ${readyClient.user.tag}`);
  const clientId = process.env.DISCORD_CLIENT_ID || readyClient.application.id;
  if (token && clientId) {
    try {
      const logs = await syncSlashCommands(
        token,
        clientId,
        process.env.DISCORD_GUILD_ID,
      );
      for (const line of logs) {
        console.log(line);
      }
    } catch (error) {
      console.error('Failed to sync slash commands on startup:', error);
    }
  }
});

client.on(Events.GuildCreate, async (guild) => {
  const clientId = process.env.DISCORD_CLIENT_ID || client.application?.id;
  if (token && clientId && !process.env.DISCORD_GUILD_ID) {
    try {
      await syncSlashCommands(token, clientId, guild.id);
      console.log(`Synced /value command to newly joined server "${guild.name}".`);
    } catch (error) {
      console.error(`Failed to sync /value to guild ${guild.id}:`, error);
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'value') {
        await handleValueAutocomplete(interaction);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'value') {
      await handleValueCommand(interaction);
    }
  } catch (error) {
    console.error('Error handling interaction:', error);
    if (interaction.isRepliable()) {
      const reply = {
        content: 'Something went wrong while checking that value.',
        flags: MessageFlags.Ephemeral,
      } as const;

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    }
  }
});

client.on(Events.Error, (error) => {
  console.error('Discord client error:', error);
});

const shouldStartHealthServer =
  !process.env.BOT_MANAGED_BY_SERVER &&
  Boolean(process.env.PORT || process.env.RENDER);

if (shouldStartHealthServer) {
  const port = Number(process.env.PORT) || 3000;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        bot: client.user?.tag ?? 'connecting',
        ready: client.isReady(),
      }),
    );
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`Health check server listening on 0.0.0.0:${port}`);
  });
}

console.log('Connecting to Discord Gateway...');
client.login(token).catch((error) => {
  console.error('Failed to log in to Discord:', error);
  process.exit(1);
});
