/** Prisma client. The provider (sqlite or postgresql) is selected by `bun run db:setup`. */
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

export async function prepareDatabase(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (url.startsWith("file:") || url.startsWith("sqlite:")) {
    await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
    await prisma.$queryRawUnsafe("PRAGMA busy_timeout=5000;");
  }
}
