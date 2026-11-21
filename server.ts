import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 3000;
const ROOT_DIR = process.cwd();
const TSX_CLI = path.resolve(ROOT_DIR, 'node_modules/tsx/dist/cli.mjs');
const DEPLOY_SCRIPT = path.resolve(ROOT_DIR, 'src/bot/deploy-commands.ts');
const BOT_SCRIPT = path.resolve(ROOT_DIR, 'src/bot/index.ts');

interface BotLogEntry {
  id: number;
  stream: 'stdout' | 'stderr' | 'system';
  message: string;
  timestamp: string;
}

let botProcess: ChildProcess | null = null;
let manualStop = false;
let restartTimer: NodeJS.Timeout | null = null;
let logSeq = 0;
const botLogs: BotLogEntry[] = [];

function appendLog(stream: BotLogEntry['stream'], raw: string): void {
  const lines = raw.replace(/\r/g, '').split('\n');
  const timestamp = new Date().toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    botLogs.push({
      id: ++logSeq,
      stream,
      message: trimmed,
      timestamp,
    });
    if (botLogs.length > 120) {
      botLogs.shift();
    }
  }
}

function getEnvStatus() {
  return {
    DISCORD_TOKEN: Boolean(process.env.DISCORD_TOKEN?.trim()),
    DISCORD_CLIENT_ID: Boolean(process.env.DISCORD_CLIENT_ID?.trim()),
    DISCORD_GUILD_ID: Boolean(process.env.DISCORD_GUILD_ID?.trim()),
  };
}

function isBotRunning(): boolean {
  return Boolean(botProcess && botProcess.exitCode === null && !botProcess.killed);
}

function runDeployScript(): Promise<{ ok: boolean; exitCode: number; output: string }> {
  return new Promise((resolve) => {
    if (!fs.existsSync(TSX_CLI)) {
      resolve({
        ok: false,
        exitCode: 1,
        output: 'tsx runtime was not found in node_modules.',
      });
      return;
    }

    const child = spawn(process.execPath, [TSX_CLI, DEPLOY_SCRIPT], {
      cwd: ROOT_DIR,
      env: process.env,
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        resolve({
          ok: false,
          exitCode: 124,
          output: `${stdout}${stderr}\nTimed out after 15 seconds waiting for Discord API.`.trim(),
        });
      }
    }, 15000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({
          ok: false,
          exitCode: 1,
          output: err.message,
        });
      }
    });

    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        const exitCode = code ?? 1;
        const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
        resolve({
          ok: exitCode === 0,
          exitCode,
          output: combined || (exitCode === 0 ? 'Command deployed.' : 'Deploy exited with an error.'),
        });
      }
    });
  });
}

async function startBotProcess(): Promise<{ ok: boolean; running: boolean; output: string }> {
  if (isBotRunning()) {
    return {
      ok: true,
      running: true,
      output: `Discord bot is already running (PID ${botProcess?.pid}).`,
    };
  }

  if (!process.env.DISCORD_TOKEN?.trim()) {
    return {
      ok: false,
      running: false,
      output:
        'Missing DISCORD_TOKEN. Add DISCORD_TOKEN and DISCORD_CLIENT_ID in AI Studio Settings -> Secrets, then run bot:start again.',
    };
  }

  if (!fs.existsSync(TSX_CLI)) {
    return {
      ok: false,
      running: false,
      output: 'tsx runtime was not found in node_modules.',
    };
  }

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  manualStop = false;

  const child = spawn(process.execPath, [TSX_CLI, BOT_SCRIPT], {
    cwd: ROOT_DIR,
    env: process.env,
    shell: false,
  });

  botProcess = child;
  appendLog('system', `Starting bot process (PID ${child.pid ?? 'unknown'})...`);

  let startupOutput = '';

  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    startupOutput += text;
    appendLog('stdout', text);
  });

  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    startupOutput += text;
    appendLog('stderr', text);
  });

  child.on('close', (code) => {
    appendLog('system', `Bot process exited with code ${code ?? 0}.`);
    if (botProcess === child) {
      botProcess = null;
      if (!manualStop && process.env.DISCORD_TOKEN?.trim()) {
        appendLog('system', 'Bot exited unexpectedly; restarting in 3s to keep /value responsive...');
        restartTimer = setTimeout(() => {
          restartTimer = null;
          if (!manualStop && !isBotRunning()) {
            void startBotProcess();
          }
        }, 3000);
      }
    }
  });

  await new Promise((r) => setTimeout(r, 750));

  const running = isBotRunning();
  return {
    ok: running,
    running,
    output:
      startupOutput.trim() ||
      (running
        ? `Bot process started (PID ${child.pid}). Connecting to Discord Gateway...`
        : 'Bot process exited during startup.'),
  };
}

function stopBotProcess(): { ok: boolean; running: boolean; output: string } {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  manualStop = true;

  if (!isBotRunning() || !botProcess) {
    botProcess = null;
    return {
      ok: true,
      running: false,
      output: 'Discord bot is not currently running.',
    };
  }

  const pid = botProcess.pid;
  botProcess.kill('SIGTERM');
  botProcess = null;
  appendLog('system', `Stopped bot process (PID ${pid}).`);
  return {
    ok: true,
    running: false,
    output: `Stopped Discord bot (PID ${pid}).`,
  };
}

async function createServer() {
  const app = express();
  const httpServer = http.createServer(app);
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/bot/status', (_req, res) => {
    res.json({
      running: isBotRunning(),
      pid: isBotRunning() ? botProcess?.pid ?? null : null,
      env: getEnvStatus(),
      logs: botLogs,
    });
  });

  app.post('/api/terminal/run', async (req, res) => {
    const action = typeof req.body?.action === 'string' ? req.body.action : '';

    if (action === 'deploy') {
      const result = await runDeployScript();
      res.json({
        ...result,
        running: isBotRunning(),
        env: getEnvStatus(),
      });
      return;
    }

    if (action === 'start') {
      const result = await startBotProcess();
      res.json({
        ...result,
        env: getEnvStatus(),
        logs: botLogs,
      });
      return;
    }

    if (action === 'stop') {
      const result = stopBotProcess();
      res.json({
        ...result,
        env: getEnvStatus(),
        logs: botLogs,
      });
      return;
    }

    if (action === 'status') {
      res.json({
        ok: true,
        running: isBotRunning(),
        pid: isBotRunning() ? botProcess?.pid ?? null : null,
        env: getEnvStatus(),
        logs: botLogs,
      });
      return;
    }

    res.status(400).json({
      ok: false,
      output: 'Unknown server action. Allowed actions: deploy, start, stop, status.',
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        port: PORT,
        middlewareMode: true,
        ws: { server: httpServer },
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(ROOT_DIR, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
    if (process.env.DISCORD_TOKEN?.trim()) {
      void startBotProcess();
    }
  });
}

createServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
