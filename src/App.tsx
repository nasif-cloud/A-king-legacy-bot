import React, { useEffect, useRef, useState } from 'react';
import {
  findKingLegacyItem,
  formatValueResponse,
  KING_LEGACY_ITEMS,
} from './bot/values';

interface TerminalLine {
  id: string;
  kind: 'command' | 'output' | 'success' | 'error' | 'muted';
  text: string;
}

interface BotStatusResponse {
  running: boolean;
  pid: number | null;
  env: {
    DISCORD_TOKEN: boolean;
    DISCORD_CLIENT_ID: boolean;
    DISCORD_GUILD_ID: boolean;
  };
  logs: Array<{
    id: number;
    stream: 'stdout' | 'stderr' | 'system';
    message: string;
    timestamp: string;
  }>;
}

const AVAILABLE_COMMANDS = [
  'help',
  'bot:deploy',
  'bot:start',
  'bot:stop',
  'bot:status',
  'env',
  'list',
  'value ',
  'clear',
];

const QUICK_COMMANDS = [
  { label: 'help', cmd: 'help' },
  { label: 'bot:deploy', cmd: 'bot:deploy' },
  { label: 'bot:start', cmd: 'bot:start' },
  { label: 'bot:stop', cmd: 'bot:stop' },
  { label: 'bot:status', cmd: 'bot:status' },
  { label: 'env', cmd: 'env' },
  { label: 'list', cmd: 'list' },
  { label: 'clear', cmd: 'clear' },
];

const HELP_TEXT = [
  'Available commands:',
  '  bot:deploy       Register /value command with Discord (alias: npm run bot:deploy)',
  '  bot:start        Start the Discord bot client (alias: npm run bot:start)',
  '  bot:stop         Stop the running Discord bot process',
  '  bot:status       Show bot status, Secrets check, and recent logs',
  '  env              Check DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID',
  '  value <item>     Simulate /value <item> reply (e.g. value dragon)',
  `  list             List all ${KING_LEGACY_ITEMS.length} King Legacy items and Sea King Fin values`,
  '  clear            Clear terminal output',
  '  help             Show this help message',
].join('\n');

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function App() {
  const [lines, setLines] = useState<TerminalLine[]>([
    {
      id: makeId(),
      kind: 'muted',
      text: 'King Legacy Discord Bot Command Prompt',
    },
    {
      id: makeId(),
      kind: 'muted',
      text: 'Type "help" to list commands, or click a command shortcut below.',
    },
  ]);
  const [input, setInput] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [botRunning, setBotRunning] = useState(false);
  const [envState, setEnvState] = useState<BotStatusResponse['env']>({
    DISCORD_TOKEN: false,
    DISCORD_CLIENT_ID: false,
    DISCORD_GUILD_ID: false,
  });
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);

  const lastLogIdRef = useRef<number>(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function appendLines(entries: Array<Omit<TerminalLine, 'id'>>) {
    setLines((prev) => [
      ...prev,
      ...entries.map((entry) => ({ ...entry, id: makeId() })),
    ]);
  }

  async function syncStatus(showOutput: boolean) {
    try {
      const res = await fetch('/api/bot/status');
      if (!res.ok) return;
      const data = (await res.json()) as BotStatusResponse;
      setBotRunning(data.running);
      setEnvState(data.env);

      const newLogs = data.logs.filter((l) => l.id > lastLogIdRef.current);
      if (newLogs.length > 0) {
        lastLogIdRef.current = newLogs[newLogs.length - 1].id;
        appendLines(
          newLogs.map((l) => ({
            kind: l.stream === 'stderr' ? 'error' : l.stream === 'system' ? 'muted' : 'output',
            text: `[${l.timestamp}] ${l.message}`,
          })),
        );
      }

      if (showOutput) {
        appendLines([
          {
            kind: data.running ? 'success' : 'muted',
            text: data.running
              ? `Bot status: RUNNING (PID ${data.pid ?? 'active'})`
              : 'Bot status: STOPPED',
          },
          {
            kind: data.env.DISCORD_TOKEN && data.env.DISCORD_CLIENT_ID ? 'output' : 'error',
            text: `Secrets: DISCORD_TOKEN=${data.env.DISCORD_TOKEN ? 'set' : 'missing'}  DISCORD_CLIENT_ID=${data.env.DISCORD_CLIENT_ID ? 'set' : 'missing'}  DISCORD_GUILD_ID=${data.env.DISCORD_GUILD_ID ? 'set' : 'optional (unset)'}`,
          },
        ]);
      }
    } catch {
      if (showOutput) {
        appendLines([
          {
            kind: 'error',
            text: 'Unable to reach bot runner server.',
          },
        ]);
      }
    }
  }

  useEffect(() => {
    void syncStatus(true);
    const timer = window.setInterval(() => {
      void syncStatus(false);
    }, 2500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  async function runServerAction(action: 'deploy' | 'start' | 'stop') {
    setIsBusy(true);
    try {
      const res = await fetch('/api/terminal/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (typeof data.running === 'boolean') setBotRunning(data.running);
      if (data.env) setEnvState(data.env);

      if (Array.isArray(data.logs)) {
        const logs = data.logs as BotStatusResponse['logs'];
        if (logs.length > 0) {
          lastLogIdRef.current = Math.max(
            lastLogIdRef.current,
            logs[logs.length - 1].id,
          );
        }
      }

      appendLines([
        {
          kind: data.ok ? 'success' : 'error',
          text: data.output || (data.ok ? 'Done.' : 'Command failed.'),
        },
      ]);
    } catch {
      appendLines([
        {
          kind: 'error',
          text: 'Failed to communicate with the local runner server.',
        },
      ]);
    } finally {
      setIsBusy(false);
    }
  }

  async function executeCommand(rawCmd: string) {
    const trimmed = rawCmd.trim();
    if (!trimmed) return;

    setCmdHistory((prev) => [trimmed, ...prev.slice(0, 49)]);
    setHistoryIndex(-1);
    setInput('');

    const normalized = trimmed.toLowerCase();

    if (normalized === 'clear' || normalized === 'cls') {
      setLines([]);
      return;
    }

    appendLines([{ kind: 'command', text: `king-legacy@bot:~$ ${trimmed}` }]);

    if (normalized === 'help' || normalized === '?') {
      appendLines([{ kind: 'output', text: HELP_TEXT }]);
      return;
    }

    if (normalized === 'env') {
      await syncStatus(false);
      appendLines([
        {
          kind: 'output',
          text: [
            `DISCORD_TOKEN      : ${envState.DISCORD_TOKEN ? 'configured' : 'MISSING (add in Settings -> Secrets)'}`,
            `DISCORD_CLIENT_ID  : ${envState.DISCORD_CLIENT_ID ? 'configured' : 'MISSING (add in Settings -> Secrets)'}`,
            `DISCORD_GUILD_ID   : ${envState.DISCORD_GUILD_ID ? 'configured' : 'unset (optional; deploys globally)'}`,
          ].join('\n'),
        },
      ]);
      return;
    }

    if (normalized === 'list' || normalized === 'values') {
      const table = KING_LEGACY_ITEMS.map((item, idx) => {
        const num = String(idx + 1).padStart(3, '0');
        const name = item.name.padEnd(25, ' ');
        const val = item.forOneFin
          ? `${item.forOneFin}x for 1 fin`.padStart(16, ' ')
          : `${item.value}x fins`.padStart(16, ' ');
        const emoji = item.emoji || '(no emoji)';
        return `${num}. ${name} ${val}   ${emoji}`;
      }).join('\n');
      appendLines([{ kind: 'output', text: table }]);
      return;
    }

    if (normalized === 'value' || normalized.startsWith('value ') || normalized.startsWith('/value ')) {
      const query = trimmed.replace(/^\/?value\s*/i, '').trim();
      if (!query) {
        appendLines([{ kind: 'error', text: 'Usage: value <item name> (e.g. value dragon)' }]);
        return;
      }
      const match = findKingLegacyItem(query);
      if (!match) {
        appendLines([
          {
            kind: 'error',
            text: `Could not find "${query}" in the King Legacy value list.`,
          },
        ]);
      } else {
        appendLines([{ kind: 'success', text: formatValueResponse(match) }]);
      }
      return;
    }

    if (
      normalized === 'bot:deploy' ||
      normalized === 'npm run bot:deploy' ||
      normalized === 'deploy'
    ) {
      appendLines([{ kind: 'muted', text: 'Running src/bot/deploy-commands.ts...' }]);
      await runServerAction('deploy');
      return;
    }

    if (
      normalized === 'bot:start' ||
      normalized === 'npm run bot:start' ||
      normalized === 'start'
    ) {
      appendLines([{ kind: 'muted', text: 'Starting src/bot/index.ts...' }]);
      await runServerAction('start');
      return;
    }

    if (normalized === 'bot:stop' || normalized === 'stop') {
      await runServerAction('stop');
      return;
    }

    if (normalized === 'bot:status' || normalized === 'status') {
      await syncStatus(true);
      return;
    }

    appendLines([
      {
        kind: 'error',
        text: `Unknown command: "${trimmed}". Type "help" to see supported commands.`,
      },
    ]);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!isBusy) {
        void executeCommand(input);
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cmdHistory.length === 0) return;
      const nextIdx = Math.min(historyIndex + 1, cmdHistory.length - 1);
      setHistoryIndex(nextIdx);
      setInput(cmdHistory[nextIdx]);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex <= 0) {
        setHistoryIndex(-1);
        setInput('');
      } else {
        const nextIdx = historyIndex - 1;
        setHistoryIndex(nextIdx);
        setInput(cmdHistory[nextIdx]);
      }
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      const lower = input.toLowerCase();
      if (!lower) return;

      if (lower.startsWith('value ')) {
        const q = lower.slice(6).trim();
        const match = KING_LEGACY_ITEMS.find((item) =>
          item.name.toLowerCase().startsWith(q),
        );
        if (match) setInput(`value ${match.name}`);
        return;
      }

      const cmdMatch = AVAILABLE_COMMANDS.find((c) => c.startsWith(lower));
      if (cmdMatch) {
        setInput(cmdMatch);
      }
    }
  }

  return (
    <div
      className="h-screen w-screen bg-[#090D16] text-slate-200 flex flex-col font-mono"
      onClick={() => inputRef.current?.focus()}
    >
      {/* Minimal Terminal Header */}
      <header className="px-4 py-3 border-b border-slate-800 bg-[#0D1320] flex flex-wrap items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-3 text-xs sm:text-sm">
          <span className="font-display font-semibold text-white whitespace-nowrap">
            King Legacy Bot Terminal
          </span>
          <span className="text-slate-600" aria-hidden="true">·</span>
          <span className={botRunning ? 'text-emerald-400' : 'text-slate-400'}>
            {botRunning ? 'Bot Running' : 'Bot Stopped'}
          </span>
          <span className="hidden sm:inline text-slate-600" aria-hidden="true">·</span>
          <span className="hidden sm:inline text-slate-400">
            Token: {envState.DISCORD_TOKEN ? 'Set' : 'Missing'}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={isBusy}
            onClick={(e) => {
              e.stopPropagation();
              void executeCommand('bot:deploy');
            }}
            className="px-3 py-1.5 rounded border border-slate-700 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-xs text-slate-200 transition-colors whitespace-nowrap"
          >
            Deploy /value
          </button>
          <button
            type="button"
            disabled={isBusy}
            onClick={(e) => {
              e.stopPropagation();
              void executeCommand(botRunning ? 'bot:stop' : 'bot:start');
            }}
            className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-xs font-medium text-white transition-colors whitespace-nowrap"
          >
            {botRunning ? 'Stop Bot' : 'Start Bot'}
          </button>
        </div>
      </header>

      {/* Scrollback Terminal Buffer */}
      <main className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-1.5 text-xs sm:text-sm leading-relaxed">
        {lines.map((line) => (
          <pre
            key={line.id}
            className={`whitespace-pre-wrap break-words font-mono ${
              line.kind === 'command'
                ? 'text-sky-400 pt-2'
                : line.kind === 'success'
                  ? 'text-emerald-400'
                  : line.kind === 'error'
                    ? 'text-rose-400'
                    : line.kind === 'muted'
                      ? 'text-slate-400'
                      : 'text-slate-200'
            }`}
          >
            {line.text}
          </pre>
        ))}
        <div ref={bottomRef} />
      </main>

      {/* Quick Command Bar + Active Prompt Line */}
      <footer className="border-t border-slate-800 bg-[#0D1320] shrink-0">
        <div className="px-4 py-2 border-b border-slate-800/80 flex items-center gap-2 overflow-x-auto">
          <span className="text-[11px] text-slate-500 whitespace-nowrap shrink-0">
            Commands:
          </span>
          {QUICK_COMMANDS.map((item) => (
            <button
              key={item.cmd}
              type="button"
              disabled={isBusy}
              onClick={(e) => {
                e.stopPropagation();
                void executeCommand(item.cmd);
              }}
              className="px-2.5 py-1 rounded border border-slate-800 bg-[#090D16] hover:border-slate-600 text-[11px] text-slate-300 hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="px-4 py-3 flex items-center gap-2.5">
          <span className="text-emerald-400 text-xs sm:text-sm whitespace-nowrap shrink-0">
            king-legacy@bot:~$
          </span>
          <input
            ref={inputRef}
            type="text"
            autoFocus
            disabled={isBusy}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isBusy ? 'Running command...' : 'Type a command (help, bot:deploy, bot:start, value dragon)...'}
            aria-label="Terminal command input"
            className="flex-1 bg-transparent text-xs sm:text-sm text-white placeholder:text-slate-600 focus:outline-none"
          />
        </div>
      </footer>
    </div>
  );
}
