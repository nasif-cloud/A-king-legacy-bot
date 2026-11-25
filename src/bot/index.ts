import 'dotenv/config';
import dns from 'node:dns';
import http from 'node:http';
import { ActivityType, Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { handleValueAutocomplete, handleValueCommand } from './command.js';
import { syncSlashCommands } from './deploy-commands.js';
import {
  handleSearchButton,
  handleSearchCommand,
  handleSearchModalSubmit,
  handleSearchSelectMenu,
} from './searchTrade.js';
import {
  indexSingleMessage,
  removeIndexedMessage,
  syncTradesFromChannels,
} from './tradeMatcher.js';
import {
  claimLocalLeadership,
  confirmActiveLeadership,
  INSTANCE_ID,
  isSupersededLocally,
  markStandbyOnConflict,
  waitForLeadershipTurn,
} from './leadership.js';
import {
  handleStickyAddCommand,
  handleStickyMessageBulkDelete,
  handleStickyMessageCreate,
  handleStickyMessageDelete,
  handleStickyRemoveCommand,
  loadStickyMessages,
  reconcileStickyMessages,
} from './stickyMessage.js';
import {
  handleWinLossButton,
  handleWinLossCommand,
  handleWinLossModalSubmit,
} from './winLoss.js';
import {
  handleStockModalSubmit,
  handleStockPingsButton,
  handleStockPingsCommand,
  handleStockPingsFruitSelect,
  handleStockPingsRoleSelect,
  handleStockSelectMenu,
  handleStockSetCommand,
  initStockSchedules,
  loadStockConfigs,
  reconcileStockChannels,
  syncMissingFruitEmojis,
} from './stockReminder.js';

// Claim local lockfile leadership and load saved sticky messages & stock configs on startup
claimLocalLeadership();
loadStickyMessages();
loadStockConfigs();

// Prefer IPv4 DNS resolution on cloud hosts (Railway, etc.)
dns.setDefaultResultOrder('ipv4first');

const token = process.env.DISCORD_TOKEN?.trim() || '';

if (!token) {
  console.error('Missing DISCORD_TOKEN in environment variables.');
  process.exit(1);
}

// Enable GuildMessages + MessageContent so the bot can read and search trade messages
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  rest: {
    timeout: 15000,
    retries: 2,
  },
});

// Updates the bot's Discord status to "in <amount> servers"
function updateBotPresence(targetClient: Client): void {
  if (!targetClient.user) return;
  const serverCount = targetClient.guilds.cache.size;
  const statusText = `in ${serverCount} ${serverCount === 1 ? 'server' : 'servers'}`;
  targetClient.user.setPresence({
    status: 'online',
    activities: [
      {
        name: statusText,
        state: statusText,
        type: ActivityType.Custom,
      },
    ],
  });
}

// Sync slash commands and warm up the trading channels cache once ready
client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Ready! Logged in as ${readyClient.user.tag} (instance ${INSTANCE_ID})`);
  updateBotPresence(readyClient);

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

  // Immediately verify, recover, and repost sticky messages after any bot reset
  void reconcileStickyMessages(readyClient);

  // Sync missing fruit application emojis, then recover & schedule 6-hour stock channels
  void syncMissingFruitEmojis(readyClient)
    .catch((error) => console.error('[Stock] Emoji sync failed:', error))
    .finally(() => {
      void initStockSchedules(readyClient);
    });

  // Warm up trade index in the background so /search trade responds fast
  void syncTradesFromChannels(readyClient, true).then((count) => {
    console.log(`Indexed ${count} messages from trading channels.`);
  });
});

// Register commands and index channels whenever the bot joins a new server
client.on(Events.GuildCreate, async (guild) => {
  updateBotPresence(client);
  const clientId = process.env.DISCORD_CLIENT_ID || client.application?.id;
  if (token && clientId && !process.env.DISCORD_GUILD_ID) {
    try {
      await syncSlashCommands(token, clientId, guild.id);
      console.log(`Synced slash commands to newly joined server "${guild.name}".`);
    } catch (error) {
      console.error(`Failed to sync commands to guild ${guild.id}:`, error);
    }
  }
  void syncTradesFromChannels(client, true);
  void reconcileStickyMessages(client, guild.id);
  void reconcileStockChannels(client, guild.id);
});

client.on(Events.GuildDelete, () => {
  updateBotPresence(client);
});

// Keep trade cache and sticky messages updated live as messages are posted
client.on(Events.MessageCreate, (message) => {
  indexSingleMessage(message);
  handleStickyMessageCreate(message);
});

client.on(Events.MessageUpdate, async (_oldMsg, newMsg) => {
  try {
    const fetched = newMsg.partial ? await newMsg.fetch() : newMsg;
    indexSingleMessage(fetched);
  } catch {
    // Ignore inaccessible edited messages
  }
});

client.on(Events.MessageDelete, (message) => {
  removeIndexedMessage(message.id);
  handleStickyMessageDelete(message);
});

client.on(Events.MessageBulkDelete, (messages) => {
  for (const id of messages.keys()) {
    removeIndexedMessage(id);
  }
  handleStickyMessageBulkDelete(messages);
});

// Route slash commands, autocomplete, buttons, dropdowns, and modal forms
client.on(Events.InteractionCreate, async (interaction) => {
  if (isSupersededLocally()) return;

  try {
    // Session-bound components run immediately if owned locally (non-owners delay inside handler)
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('wl_calc:')) {
        await handleWinLossButton(interaction);
      } else if (interaction.customId.startsWith('stk_ping_btn:')) {
        await handleStockPingsButton(interaction);
      } else {
        await handleSearchButton(interaction);
      }
      confirmActiveLeadership();
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('stk_ping_fruit:')) {
        await handleStockPingsFruitSelect(interaction);
      } else if (interaction.customId.startsWith('stk_menu:')) {
        await handleStockSelectMenu(interaction);
      } else {
        await handleSearchSelectMenu(interaction);
      }
      confirmActiveLeadership();
      return;
    }

    if (interaction.isRoleSelectMenu()) {
      if (interaction.customId.startsWith('stk_ping_role:')) {
        await handleStockPingsRoleSelect(interaction);
      }
      confirmActiveLeadership();
      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('wl_modal:')) {
        await handleWinLossModalSubmit(interaction);
      } else if (interaction.customId.startsWith('stk_modal:')) {
        await handleStockModalSubmit(interaction);
      } else {
        await handleSearchModalSubmit(interaction);
      }
      confirmActiveLeadership();
      return;
    }

    // Unclaimed commands/autocomplete wait an age-based turn so the newest instance always wins
    if (!(await waitForLeadershipTurn())) return;

    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'value') {
        await handleValueAutocomplete(interaction);
        confirmActiveLeadership();
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'value') {
      await handleValueCommand(interaction);
      confirmActiveLeadership();
    } else if (interaction.commandName === 'trade') {
      await handleSearchCommand(interaction);
      confirmActiveLeadership();
    } else if (interaction.commandName === 'stickymessage') {
      await handleStickyAddCommand(interaction);
      confirmActiveLeadership();
    } else if (interaction.commandName === 'stickmessage') {
      await handleStickyRemoveCommand(interaction);
      confirmActiveLeadership();
    } else if (interaction.commandName === 'wl') {
      await handleWinLossCommand(interaction);
      confirmActiveLeadership();
    } else if (interaction.commandName === 'stockset') {
      await handleStockSetCommand(interaction);
      confirmActiveLeadership();
    } else if (interaction.commandName === 'stockpings') {
      await handleStockPingsCommand(interaction);
      confirmActiveLeadership();
    }
  } catch (error) {
    const code = (error as { code?: number })?.code;
    if (code === 40060) {
      // Another (newer) instance handled this interaction first; enter passive standby
      markStandbyOnConflict();
      return;
    }
    if (code === 10062) {
      console.warn(
        `[Interaction] Timed out before ACK (10062) on ${
          'customId' in interaction ? interaction.customId : interaction.type
        }`,
      );
      return;
    }

    console.error('Error handling interaction:', error);
    if (interaction.isRepliable()) {
      const reply = {
        content: 'Something went wrong while running that action',
        flags: MessageFlags.Ephemeral,
      } as const;

      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(reply);
        } else {
          await interaction.reply(reply);
        }
      } catch {
        // Ignore follow-up errors on expired interactions
      }
    }
  }
});

client.on(Events.Warn, (info) => {
  console.warn('[Discord Warn]', info);
});

client.on(Events.Error, (error) => {
  console.error('[Discord Error]', error);
});

client.on(Events.ShardError, (error, shardId) => {
  console.error(`[Discord Shard ${shardId} Error]`, error.message);
});

client.on(Events.ShardDisconnect, (event, shardId) => {
  console.warn(`[Discord Shard ${shardId} Disconnect] code=${event.code}`);
});

client.on(Events.ShardReconnecting, (shardId) => {
  console.log(`[Discord Shard ${shardId}] Reconnecting...`);
});

client.on(Events.ShardResume, (shardId) => {
  console.log(`[Discord Shard ${shardId}] Resumed; reconciling sticky & stock messages...`);
  updateBotPresence(client);
  void reconcileStickyMessages(client);
  void syncMissingFruitEmojis(client)
    .catch((error) => console.error('[Stock] Emoji sync failed on resume:', error))
    .finally(() => {
      void initStockSchedules(client);
    });
});

// Lightweight health server if run standalone with PORT set
if (!process.env.BOT_MANAGED_BY_SERVER && process.env.PORT) {
  const port = Number(process.env.PORT) || 3000;
  http
    .createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          bot: client.user?.tag ?? 'connecting',
          ready: client.isReady(),
        }),
      );
    })
    .listen(port, '0.0.0.0', () => {
      console.log(`Health check server listening on 0.0.0.0:${port}`);
    });
}

console.log('Connecting to Discord Gateway...');
client.login(token).catch((error) => {
  console.error('Failed to log in to Discord:', error);
  process.exit(1);
});
