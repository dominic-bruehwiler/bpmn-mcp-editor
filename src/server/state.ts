/** Row shaping shared by the HTTP API, the MCP tools, and the sync loop. */
import type { Process } from "@prisma/client";

export type LockState = { holder: "agent"; expiresAt: string } | null;

export type ProcessSummary = {
  id: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lock: LockState;
  userActive: boolean;
};

export type ProcessDetails = ProcessSummary & { xml: string };

const AGENT_LOCK_MS = 45_000;

export function agentLockMs(): number {
  return AGENT_LOCK_MS;
}

export function userActiveMs(): number {
  return 8_000;
}

export function isAgentLock(row: Pick<Process, "lockHolder" | "lockExpiresAt">): boolean {
  return row.lockHolder === "agent" && !!row.lockExpiresAt && row.lockExpiresAt.getTime() > Date.now();
}

export function isUserActive(row: Pick<Process, "userActiveUntil">): boolean {
  return !!row.userActiveUntil && row.userActiveUntil.getTime() > Date.now();
}

export function toSummary(row: Process): ProcessSummary {
  return {
    id: row.id,
    name: row.name,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lock: isAgentLock(row) && row.lockExpiresAt
      ? { holder: "agent", expiresAt: row.lockExpiresAt.toISOString() }
      : null,
    userActive: isUserActive(row),
  };
}

export function toDetails(row: Process): ProcessDetails {
  return { ...toSummary(row), xml: row.xml };
}

/** One mutation at a time per diagram inside this process. The revision check covers other processes. */
const tails = new Map<string, Promise<unknown>>();

export function enqueue<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previous = tails.get(id) ?? Promise.resolve();
  const run = previous.then(work, work);
  tails.set(id, run.then(() => undefined, () => undefined));
  return run;
}
