# King Legacy Value Discord Bot

Minimal `discord.js` v14 support bot for **King Legacy** with a single `/value <value>` slash command and autocomplete.

## Bot Project Files

- `src/bot/values.ts` — All 22 King Legacy items, custom Discord emoji tags, Sea King Fin values, lookup/autocomplete helpers, and exact response formatter.
- `src/bot/command.ts` — `/value` slash command definition (`SlashCommandBuilder`), autocomplete handler, and reply handler.
- `src/bot/deploy-commands.ts` — Registers `/value` with Discord via REST API.
- `src/bot/index.ts` — Bot client entry point.

## Setup

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications) and create a Bot user.
2. Copy `.env.example` to `.env` and set:
   - `DISCORD_TOKEN` — Your bot token
   - `DISCORD_CLIENT_ID` — Your application's Client ID
   - `DISCORD_GUILD_ID` (optional) — A test server ID for instant slash-command registration
3. Invite the bot to your server using OAuth2 URL Generator with scopes `bot` and `applications.commands`.
4. Register the `/value` slash command:
   ```bash
   npm run bot:deploy
   ```
5. Start the bot:
   ```bash
   npm run bot:start
   ```
