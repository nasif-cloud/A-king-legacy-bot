import crypto from 'node:crypto';
import {
  findKingLegacyItem,
  formatValueResponse,
  searchKingLegacyItems,
} from './values.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

interface InteractionOption {
  name: string;
  value?: string | number | boolean;
  focused?: boolean;
  options?: InteractionOption[];
}

export interface DiscordHttpInteractionPayload {
  type: number;
  data?: {
    name?: string;
    options?: InteractionOption[];
  };
}

export interface DiscordHttpInteractionResponse {
  type: number;
  data?: {
    content?: string;
    flags?: number;
    choices?: Array<{ name: string; value: string }>;
  };
}

export function verifyDiscordSignature(
  rawBody: Buffer | string,
  signatureHex: string,
  timestamp: string,
  publicKeyHex: string,
): boolean {
  try {
    const cleanPubHex = publicKeyHex.trim();
    const cleanSigHex = signatureHex.trim();
    if (!cleanPubHex || !cleanSigHex || !timestamp) return false;
    if (cleanPubHex.length !== 64 || cleanSigHex.length !== 128) return false;

    const pubBytes = Buffer.from(cleanPubHex, 'hex');
    const sigBytes = Buffer.from(cleanSigHex, 'hex');
    if (pubBytes.length !== 32 || sigBytes.length !== 64) return false;

    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, pubBytes]),
      format: 'der',
      type: 'spki',
    });

    const bodyBuf = Buffer.isBuffer(rawBody)
      ? rawBody
      : Buffer.from(rawBody, 'utf8');
    const message = Buffer.concat([Buffer.from(timestamp, 'utf8'), bodyBuf]);

    return crypto.verify(null, message, publicKey, sigBytes);
  } catch {
    return false;
  }
}

function extractQueryOption(options: InteractionOption[] | undefined): string {
  if (!Array.isArray(options) || options.length === 0) return '';
  const focused = options.find((opt) => opt.focused);
  if (focused && focused.value !== undefined) {
    return String(focused.value);
  }
  const named =
    options.find((opt) => opt.name === 'item') ??
    options.find((opt) => opt.name === 'items') ??
    options.find((opt) => opt.name === 'value') ??
    options[0];
  return named?.value !== undefined ? String(named.value) : '';
}

export function handleHttpInteraction(
  payload: DiscordHttpInteractionPayload,
): DiscordHttpInteractionResponse {
  // Type 1: Discord PING verification
  if (payload.type === 1) {
    return { type: 1 };
  }

  const commandName = payload.data?.name;

  // Type 4: ApplicationCommandAutocomplete
  if (payload.type === 4 && commandName === 'value') {
    const focusedValue = extractQueryOption(payload.data?.options);
    const matches = searchKingLegacyItems(focusedValue, 25);
    return {
      type: 8,
      data: {
        choices: matches.map((item) => ({
          name: item.name.slice(0, 100),
          value: item.name.slice(0, 100),
        })),
      },
    };
  }

  // Type 2: ApplicationCommand
  if (payload.type === 2 && commandName === 'value') {
    const query = extractQueryOption(payload.data?.options);
    const item = findKingLegacyItem(query);
    if (!item) {
      return {
        type: 4,
        data: {
          content: `Could not find **"${query}"** in the King Legacy value list. Try starting to type an item name to pick from autocomplete.`,
          flags: 64,
        },
      };
    }

    return {
      type: 4,
      data: {
        content: formatValueResponse(item),
      },
    };
  }

  return {
    type: 4,
    data: {
      content: 'Unsupported command.',
      flags: 64,
    },
  };
}
