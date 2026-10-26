/**
 * Stored diagrams. The browser and the MCP agent share these rows.
 * An agent lock makes the editor read-only; a recent user edit blocks a new agent lock.
 */
import { publish } from "./events";
import { prisma } from "./db";
import { BadRequestError, ConflictError, NotFoundError, ValidationError } from "./errors";
import { createExecutableDiagram, editDiagram, renameDiagram } from "./bpmn/edit";
import { describeDiagram } from "./bpmn/inspect";
import { layoutDiagram } from "./bpmn/layout";
import { lintDiagram } from "./bpmn/lint";
import { readDiagram } from "./bpmn/moddle";
import type { DiagramOp } from "./bpmn/types";
import {
  agentLockMs,
  enqueue,
  isAgentLock,
  isUserActive,
  toDetails,
  toSummary,
  userActiveMs,
  type ProcessDetails,
  type ProcessSummary,
} from "./state";

const ID_PATTERN = /^[A-Za-z_][\w.-]*$/;

export async function listProcesses(): Promise<ProcessSummary[]> {
  const rows = await prisma.process.findMany({ orderBy: { updatedAt: "desc" } });
  return rows.map(toSummary);
}

export async function getProcess(id: string): Promise<ProcessDetails> {
  return toDetails(await load(id));
}

export async function createProcess(input: {
  name: string;
  processId?: string;
  historyTimeToLive?: string;
  lockForAgent?: boolean;
}): Promise<ProcessDetails & { lockToken?: string }> {
  const name = input.name.trim();
  if (!name) throw new BadRequestError("A process name is required.");
  const processId = input.processId ?? `Process_${crypto.randomUUID().replaceAll("-", "").slice(0, 7)}`;
  if (!ID_PATTERN.test(processId)) throw new BadRequestError(`"${processId}" is not a valid process id.`);

  const xml = await createExecutableDiagram({
    name,
    processId,
    historyTimeToLive: input.historyTimeToLive,
  });
  const id = `proc_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const lockToken = input.lockForAgent ? crypto.randomUUID() : undefined;
  const row = await prisma.process.create({
    data: {
      id,
      name,
      xml,
      lockHolder: lockToken ? "agent" : null,
      lockToken,
      lockExpiresAt: lockToken ? new Date(Date.now() + agentLockMs()) : null,
    },
  });
  const details = toDetails(row);
  publish({ type: "process.updated", process: details });
  return { ...details, lockToken };
}

export async function saveUserXml(id: string, xml: string, expectedRevision: number): Promise<ProcessDetails> {
  return enqueue(id, async () => {
    const row = await load(id);
    assertRevision(row.revision, expectedRevision);
    if (isAgentLock(row)) {
      throw new ConflictError("The agent is editing this diagram.");
    }
    const diagram = await readDiagram(xml);
    const name = typeof diagram.process.name === "string" && diagram.process.name
      ? diagram.process.name
      : row.name;
    const updated = await commit(id, row.revision, {
      xml,
      name,
      userActiveUntil: new Date(Date.now() + userActiveMs()),
    });
    return updated;
  });
}

export async function renameProcess(id: string, name: string, expectedRevision: number): Promise<ProcessDetails> {
  return enqueue(id, async () => {
    const trimmed = name.trim();
    if (!trimmed) throw new BadRequestError("A process name is required.");
    const row = await load(id);
    assertRevision(row.revision, expectedRevision);
    if (isAgentLock(row)) throw new ConflictError("The agent is editing this diagram.");
    const xml = await renameDiagram(row.xml, trimmed);
    return commit(id, row.revision, { name: trimmed, xml });
  });
}

export async function deleteProcess(id: string): Promise<void> {
  return enqueue(id, async () => {
    const row = await load(id);
    if (isAgentLock(row)) throw new ConflictError("The agent is editing this diagram.");
    await prisma.process.delete({ where: { id } });
    publish({ type: "process.deleted", id });
  });
}

export async function touchPresence(id: string): Promise<void> {
  const row = await load(id);
  if (isAgentLock(row)) throw new ConflictError("The agent is editing this diagram.");
  await prisma.process.update({
    where: { id },
    data: { userActiveUntil: new Date(Date.now() + userActiveMs()) },
  });
}

export async function layoutStoredDiagram(id: string, expectedRevision: number): Promise<ProcessDetails> {
  return enqueue(id, async () => {
    const row = await load(id);
    assertRevision(row.revision, expectedRevision);
    if (isAgentLock(row)) throw new ConflictError("The agent is editing this diagram.");
    const xml = await layoutDiagram(row.xml);
    const diagram = await readDiagram(xml);
    const name = typeof diagram.process.name === "string" && diagram.process.name ? diagram.process.name : row.name;
    return commit(id, row.revision, { xml, name });
  });
}

export async function validateStoredDiagram(id: string, profile: "build" | "deploy") {
  const row = await load(id);
  const description = await describeDiagram(row.xml, profile);
  return { id: row.id, revision: row.revision, profile, ...description };
}

export async function acquireLock(id: string): Promise<{ lockToken: string; revision: number; expiresAt: string }> {
  return enqueue(id, async () => {
    const row = await load(id);
    if (isUserActive(row)) {
      throw new ConflictError("The user is currently editing this diagram. Retry in a few seconds.");
    }
    if (isAgentLock(row)) {
      throw new ConflictError("This diagram is already locked by an agent.");
    }
    const lockToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + agentLockMs());
    const updated = await prisma.process.update({
      where: { id },
      data: { lockHolder: "agent", lockToken, lockExpiresAt: expiresAt },
    });
    publish({ type: "process.updated", process: toDetails(updated) });
    return { lockToken, revision: updated.revision, expiresAt: expiresAt.toISOString() };
  });
}

export async function releaseLock(id: string, lockToken: string) {
  return enqueue(id, async () => {
    const row = await load(id);
    assertToken(row.lockToken, lockToken);
    const updated = await prisma.process.update({
      where: { id },
      data: { lockHolder: null, lockToken: null, lockExpiresAt: null },
    });
    publish({ type: "process.updated", process: toDetails(updated) });
    const issues = await lintDiagram(updated.xml, "deploy");
    return { id, revision: updated.revision, issues };
  });
}

export async function mutateProcess(input: {
  id: string;
  lockToken: string;
  expectedRevision: number;
  ops: DiagramOp[];
  layout?: boolean;
}): Promise<ProcessDetails & { refs: Record<string, string>; issues: Awaited<ReturnType<typeof editDiagram>>["issues"] }> {
  return enqueue(input.id, async () => {
    const row = await load(input.id);
    assertToken(row.lockToken, input.lockToken);
    if (!isAgentLock(row)) throw new ConflictError("The agent lock has expired. Acquire it again.");
    assertRevision(row.revision, input.expectedRevision);
    const edited = await editDiagram(row.xml, input.ops, { layout: input.layout, profile: "build" });
    const details = await commit(input.id, row.revision, {
      xml: edited.xml,
      name: edited.name,
      lockExpiresAt: new Date(Date.now() + agentLockMs()),
    });
    return { ...details, refs: edited.refs, issues: edited.issues };
  });
}

export async function importProcessXml(input: {
  id: string;
  lockToken: string;
  expectedRevision: number;
  xml: string;
}): Promise<ProcessDetails & { issues: Awaited<ReturnType<typeof lintDiagram>> }> {
  return enqueue(input.id, async () => {
    const row = await load(input.id);
    assertToken(row.lockToken, input.lockToken);
    if (!isAgentLock(row)) throw new ConflictError("The agent lock has expired. Acquire it again.");
    assertRevision(row.revision, input.expectedRevision);
    await readDiagram(input.xml);
    const xml = input.xml.includes("BPMNShape") ? input.xml : await layoutDiagram(input.xml);
    const issues = await lintDiagram(xml, "build");
    const errors = issues.filter((issue) => issue.severity === "error");
    if (errors.length > 0) {
      throw new ValidationError("The imported diagram is not valid.", issues);
    }
    const diagram = await readDiagram(xml);
    const name = typeof diagram.process.name === "string" && diagram.process.name ? diagram.process.name : row.name;
    const details = await commit(input.id, row.revision, {
      xml,
      name,
      lockExpiresAt: new Date(Date.now() + agentLockMs()),
    });
    return { ...details, issues };
  });
}

export async function seedIfEmpty(): Promise<void> {
  const count = await prisma.process.count();
  if (count > 0) return;
  const { invoiceDiagram } = await import("./sample");
  const xml = await invoiceDiagram();
  const row = await prisma.process.create({
    data: { id: "proc_invoice", name: "Invoice approval", xml },
  });
  publish({ type: "process.updated", process: toDetails(row) });
}

async function load(id: string) {
  const row = await prisma.process.findUnique({ where: { id } });
  if (!row) throw new NotFoundError();
  if (row.lockExpiresAt && row.lockExpiresAt.getTime() <= Date.now()) {
    return prisma.process.update({
      where: { id },
      data: { lockHolder: null, lockToken: null, lockExpiresAt: null },
    });
  }
  return row;
}

async function commit(
  id: string,
  revision: number,
  data: {
    xml?: string;
    name?: string;
    userActiveUntil?: Date;
    lockExpiresAt?: Date;
  },
): Promise<ProcessDetails> {
  const result = await prisma.process.updateMany({
    where: { id, revision },
    data: { ...data, revision: { increment: 1 } },
  });
  if (result.count !== 1) {
    const current = await prisma.process.findUnique({ where: { id } });
    throw new ConflictError(`The diagram changed. Current revision is ${current?.revision ?? "unknown"}.`);
  }
  const row = await prisma.process.findUniqueOrThrow({ where: { id } });
  const details = toDetails(row);
  publish({ type: "process.updated", process: details });
  return details;
}

function assertRevision(current: number, expected: number) {
  if (current !== expected) {
    throw new ConflictError(`The diagram changed. Current revision is ${current}.`);
  }
}

function assertToken(current: string | null, provided: string) {
  if (!current || current !== provided) {
    throw new ConflictError("The lock token is missing or no longer valid.");
  }
}
