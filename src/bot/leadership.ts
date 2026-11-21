import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Unique ID and startup timestamp for this running bot instance
export const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
export const INSTANCE_STARTED_AT = Date.now();

const LEADER_LOCK_FILE = path.join(os.tmpdir(), 'king-legacy-bot-leader.json');
const STANDBY_DURATION_MS = 10 * 60 * 1000;

let standbyUntil = 0;

interface LeaderLockData {
  instanceId: string;
  startedAt: number;
  pid: number;
}

// Writes this newest instance's startup timestamp to the local temp lockfile
export function claimLocalLeadership(): void {
  try {
    const payload: LeaderLockData = {
      instanceId: INSTANCE_ID,
      startedAt: INSTANCE_STARTED_AT,
      pid: process.pid,
    };
    fs.writeFileSync(LEADER_LOCK_FILE, JSON.stringify(payload), 'utf8');
  } catch {
    // Ignore filesystem permission issues on read-only environments
  }
}

// Checks if a newer instance on the same host has already claimed leadership
export function isSupersededLocally(): boolean {
  try {
    if (!fs.existsSync(LEADER_LOCK_FILE)) return false;
    const raw = fs.readFileSync(LEADER_LOCK_FILE, 'utf8');
    const data = JSON.parse(raw) as Partial<LeaderLockData>;
    if (typeof data.startedAt !== 'number' || typeof data.instanceId !== 'string') {
      return false;
    }
    return data.startedAt > INSTANCE_STARTED_AT && data.instanceId !== INSTANCE_ID;
  } catch {
    return false;
  }
}

// Calculates a small age-based delay so newer instances always respond before older instances
export function getLeaderElectionDelayMs(): number {
  const uptimeSeconds = Math.max(0, (Date.now() - INSTANCE_STARTED_AT) / 1000);
  // Brand-new instances wait ~0-100ms; older instances wait up to 650ms (+1100ms if in standby)
  const ageDelay = Math.min(
    650,
    Math.floor(Math.log2(1 + uptimeSeconds / 15) * 100),
  );
  const inStandby = Date.now() < standbyUntil;
  return inStandby ? ageDelay + 1100 : ageDelay;
}

// Waits for this instance's turn on unclaimed interactions; returns false if a newer local instance took over
export async function waitForLeadershipTurn(): Promise<boolean> {
  if (isSupersededLocally()) return false;

  const delayMs = getLeaderElectionDelayMs();
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return !isSupersededLocally();
}

// Marks this instance as passive standby when another instance handles an interaction first (40060/10062)
export function markStandbyOnConflict(): void {
  const wasInStandby = Date.now() < standbyUntil;
  standbyUntil = Date.now() + STANDBY_DURATION_MS;
  if (!wasInStandby) {
    console.log(
      `[Leadership] Newer or sibling instance detected; instance ${INSTANCE_ID} entering passive standby`,
    );
  }
}

// Clears standby if this instance successfully handled an interaction without conflict
export function confirmActiveLeadership(): void {
  if (standbyUntil > 0 && Date.now() < standbyUntil) {
    standbyUntil = 0;
  }
}

// Returns true when this instance has yielded leadership to a newer sibling instance
export function isInPassiveStandby(): boolean {
  return Date.now() < standbyUntil;
}
