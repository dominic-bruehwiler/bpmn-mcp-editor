/** Polls the database so edits from a separate stdio MCP process show up in the browser. */
import { prisma } from "./db";
import { publish } from "./events";
import { toDetails } from "./state";

const seen = new Map<string, string>();

export function startSync(): void {
  setInterval(() => {
    void scan();
  }, 1000);
}

async function scan(): Promise<void> {
  await prisma.process.updateMany({
    where: { lockExpiresAt: { lt: new Date() } },
    data: { lockHolder: null, lockToken: null, lockExpiresAt: null },
  });

  const rows = await prisma.process.findMany();
  const ids = new Set(rows.map((row) => row.id));
  for (const id of seen.keys()) {
    if (!ids.has(id)) {
      seen.delete(id);
      publish({ type: "process.deleted", id });
    }
  }

  for (const row of rows) {
    const signature = `${row.revision}|${row.lockHolder ?? ""}|${row.lockExpiresAt?.toISOString() ?? ""}`;
    if (seen.get(row.id) === signature) continue;
    seen.set(row.id, signature);
    publish({ type: "process.updated", process: toDetails(row) });
  }
}
