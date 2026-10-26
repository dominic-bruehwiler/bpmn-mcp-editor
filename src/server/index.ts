/**
 * Web server. Serves the API, the MCP endpoint, and (in production) the built editor.
 * The browser dev server proxies to this process.
 */
import { serveStatic } from "hono/bun";
import { prepareDatabase } from "./db";
import { createApp } from "./app";
import { seedIfEmpty } from "./processes";
import { startSync } from "./sync";

const port = Number(process.env.PORT ?? 3001);
const app = createApp();

if (process.env.NODE_ENV === "production") {
  app.use("*", serveStatic({ root: "./dist/web" }));
  app.get("*", async (c, next) => {
    const path = c.req.path;
    if (path.startsWith("/api") || path.startsWith("/mcp") || path === "/ws") return next();
    const relative = path === "/" ? "index.html" : path.slice(1);
    const file = Bun.file(`./dist/web/${relative}`);
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file("./dist/web/index.html"));
  });
}

await prepareDatabase();
await seedIfEmpty();
startSync();

Bun.serve({
  port,
  fetch: app.fetch,
  websocket: (await import("hono/bun")).websocket,
});

console.log(`BPMN editor API on http://localhost:${port}`);
console.log(`MCP endpoint on http://localhost:${port}/mcp`);
