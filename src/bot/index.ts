import 'dotenv/config';
import dns from 'node:dns';
import http from 'node:http';
import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { handleValueAutocomplete, handleValueCommand } from './command.js';
import { syncSlashCommands } from './deploy-commands.js';
import {
  handleHttpInteraction,
  verifyDiscordSignature,
} from './interactions.js';
import type { DiscordHttpInteractionPayload } from './interactions.js';

// Avoid Node IPv6 Happy Eyeballs connection stalls on Render / cloud hosts
dns.setDefaultResultOrder('ipv4first');

const token = process.env.DISCORD_TOKEN?.trim() || '';
const publicKey = process.env.DISCORD_PUBLIC_KEY?.trim() || '';
const interactionsOnly = process.env.DISCORD_INTERACTIONS_ONLY === 'true';

if (!token && !(interactionsOnly && publicKey)) {
  console.error(
    'Missing DISCORD_TOKEN (or DISCORD_PUBLIC_KEY with DISCORD_INTERACTIONS_ONLY=true) in environment variables.',
  );
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  rest: {
    timeout: 15000,
    retries: 2,
  },
});

let gatewayStatus = interactionsOnly ? 'disabled (interactions-only)' : 'connecting';

client.once(Events.ClientReady, async (readyClient) => {
  gatewayStatus = `ready (${readyClient.user.tag})`;
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

client.on(Events.Warn, (info) => {
  console.warn('[Discord Warn]', info);
});

client.on(Events.Error, (error) => {
  console.error('[Discord Error]', error);
});

client.on(Events.ShardError, (error, shardId) => {
  gatewayStatus = `shard ${shardId} error: ${error.message}`;
  console.error(`[Discord Shard ${shardId} Error]`, error.message);
});

client.on(Events.ShardDisconnect, (event, shardId) => {
  gatewayStatus = `disconnected (code ${event.code})`;
  console.warn(`[Discord Shard ${shardId} Disconnect] code=${event.code}`);
});

client.on(Events.ShardReconnecting, (shardId) => {
  gatewayStatus = 'reconnecting';
  console.log(`[Discord Shard ${shardId}] Reconnecting...`);
});

client.rest.on('rateLimited', (info) => {
  console.warn(
    `[Discord REST RateLimit] route=${info.route} retryAfter=${info.retryAfter}ms global=${info.global}`,
  );
});

function readRawBody(req: http.IncomingMessage, maxBytes = 256 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const shouldStartHttpServer =
  !process.env.BOT_MANAGED_BY_SERVER &&
  Boolean(process.env.PORT || process.env.RENDER);

if (shouldStartHttpServer) {
  const port = Number(process.env.PORT) || 3000;
  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];

    if (
      req.method === 'POST' &&
      (urlPath === '/interactions' ||
        urlPath === '/interactions/' ||
        urlPath === '/api/interactions' ||
        urlPath === '/api/interactions/')
    ) {
      if (!publicKey) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'DISCORD_PUBLIC_KEY is not configured in environment variables.',
          }),
        );
        return;
      }

      try {
        const rawBody = await readRawBody(req);
        const signature = String(req.headers['x-signature-ed25519'] ?? '');
        const timestamp = String(req.headers['x-signature-timestamp'] ?? '');

        if (!verifyDiscordSignature(rawBody, signature, timestamp, publicKey)) {
          res.writeHead(401, { 'Content-Type': 'text/plain' });
          res.end('Invalid request signature');
          return;
        }

        const payload = JSON.parse(
          rawBody.toString('utf8'),
        ) as DiscordHttpInteractionPayload;
        const response = handleHttpInteraction(payload);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (error) {
        console.error('[HTTP Interactions Error]', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad interaction payload' }));
      }
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        bot: client.user?.tag ?? 'connecting',
        gatewayReady: client.isReady(),
        gatewayStatus,
        interactionsEndpoint: Boolean(publicKey),
      }),
    );
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`Health & Interactions server listening on 0.0.0.0:${port}`);
    if (publicKey) {
      console.log('Discord HTTP Interactions endpoint ready at POST /interactions');
    }
  });
}

async function checkGatewayPreflight(botToken: string): Promise<{
  ok: boolean;
  retryDelayMs?: number;
  fatal?: boolean;
}> {
  try {
    const res = await fetch('https://discord.com/api/v10/gateway/bot', {
      headers: { Authorization: `Bot ${botToken}` },
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      return { ok: true };
    }

    if (res.status === 401) {
      gatewayStatus = 'invalid token (401)';
      console.error('Discord rejected DISCORD_TOKEN (HTTP 401 Unauthorized).');
      return { ok: false, fatal: !publicKey };
    }

    if (res.status === 429) {
      const retryAfterSec = Number(res.headers.get('retry-after') || '60');
      const waitSec = Number.isFinite(retryAfterSec)
        ? Math.min(Math.max(retryAfterSec, 15), 300)
        : 60;
      gatewayStatus = `rate limited by Discord/Cloudflare (429, retry in ${waitSec}s)`;
      console.warn(
        `Discord Gateway REST returned HTTP 429 (shared host IP rate limit). Retrying Gateway in ${waitSec}s.${
          publicKey
            ? ' HTTP Interactions (/interactions) remains active.'
            : ' Tip: set DISCORD_PUBLIC_KEY and Discord Interactions Endpoint URL to bypass shared-IP Gateway blocks on Render.'
        }`,
      );
      return { ok: false, retryDelayMs: waitSec * 1000 };
    }

    const bodyText = (await res.text()).slice(0, 200);
    gatewayStatus = `preflight HTTP ${res.status}`;
    console.warn(`Discord Gateway preflight returned HTTP ${res.status}: ${bodyText}`);
    return { ok: false, retryDelayMs: 30000 };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    gatewayStatus = `preflight failed: ${msg}`;
    console.warn(`Discord Gateway preflight network error: ${msg}`);
    return { ok: false, retryDelayMs: 20000 };
  }
}

async function connectWithRetry(): Promise<void> {
  if (interactionsOnly) {
    console.log('DISCORD_INTERACTIONS_ONLY=true: running HTTP Interactions endpoint only.');
    return;
  }

  let attempt = 0;
  while (!client.isReady()) {
    attempt += 1;
    gatewayStatus = `connecting (attempt ${attempt})`;
    console.log(`Connecting to Discord Gateway (attempt ${attempt})...`);

    const preflight = await checkGatewayPreflight(token);
    if (!preflight.ok) {
      if (preflight.fatal) {
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, preflight.retryDelayMs ?? 30000));
      continue;
    }

    try {
      await Promise.race([
        client.login(token),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Gateway login timed out after 30s')),
            30000,
          ),
        ),
      ]);
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      gatewayStatus = `login failed: ${msg}`;
      console.error(`Discord Gateway login failed: ${msg}`);
      try {
        await client.destroy();
      } catch {
        // ignore cleanup error
      }
      await new Promise((r) => setTimeout(r, 30000));
    }
  }
}

void connectWithRetry();
