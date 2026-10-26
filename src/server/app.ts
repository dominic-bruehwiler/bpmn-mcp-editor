/** HTTP API, WebSocket updates, and the streamable MCP endpoint. */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { upgradeWebSocket } from "hono/bun";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { subscribe } from "./events";
import { BadRequestError, HttpError } from "./errors";
import { createMcpServer } from "./mcp";
import {
  createProcess,
  deleteProcess,
  getProcess,
  layoutStoredDiagram,
  listProcesses,
  renameProcess,
  saveUserXml,
  touchPresence,
  validateStoredDiagram,
} from "./processes";

export function createApp(): Hono {
  const app = new Hono();
  app.use("*", cors());

  app.get("/api/health", (c) => {
    const url = process.env.DATABASE_URL ?? "";
    return c.json({
      ok: true,
      database: url.startsWith("postgres") ? "postgresql" : "sqlite",
    });
  });

  app.get("/api/processes", async (c) => {
    try {
      return c.json(await listProcesses());
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post("/api/processes", async (c) => {
    try {
      const body = parse(z.object({ name: z.string().min(1), processId: z.string().optional() }), await c.req.json());
      return c.json(await createProcess(body), 201);
    } catch (error) {
      return fail(c, error);
    }
  });

  app.get("/api/processes/:id", async (c) => {
    try {
      return c.json(await getProcess(c.req.param("id")));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.put("/api/processes/:id", async (c) => {
    try {
      const body = parse(
        z.object({ xml: z.string().min(1), expectedRevision: z.number().int() }),
        await c.req.json(),
      );
      return c.json(await saveUserXml(c.req.param("id"), body.xml, body.expectedRevision));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.patch("/api/processes/:id", async (c) => {
    try {
      const body = parse(
        z.object({ name: z.string().min(1), expectedRevision: z.number().int() }),
        await c.req.json(),
      );
      return c.json(await renameProcess(c.req.param("id"), body.name, body.expectedRevision));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.delete("/api/processes/:id", async (c) => {
    try {
      await deleteProcess(c.req.param("id"));
      return c.json({ ok: true });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post("/api/processes/:id/layout", async (c) => {
    try {
      const body = parse(z.object({ expectedRevision: z.number().int() }), await c.req.json());
      return c.json(await layoutStoredDiagram(c.req.param("id"), body.expectedRevision));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post("/api/processes/:id/validate", async (c) => {
    try {
      const body = parse(
        z.object({ profile: z.enum(["build", "deploy"]).optional() }),
        await c.req.json().catch(() => ({})),
      );
      return c.json(await validateStoredDiagram(c.req.param("id"), body.profile ?? "deploy"));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post("/api/processes/:id/presence", async (c) => {
    try {
      await touchPresence(c.req.param("id"));
      return c.json({ ok: true });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.get("/ws", upgradeWebSocket(() => {
    let unsubscribe = () => {};
    return {
      onOpen(_event, ws) {
        unsubscribe = subscribe((message) => ws.send(message));
      },
      onClose() {
        unsubscribe();
      },
    };
  }));

  app.all("/mcp", async (c) => {
    const apiKey = process.env.MCP_API_KEY;
    if (apiKey && c.req.header("authorization") !== `Bearer ${apiKey}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const server = createMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(c.req.raw);
    if (!response.body) {
      await server.close();
      return response;
    }
    const stream = response.body.pipeThrough(new TransformStream({
      flush() {
        void server.close();
      },
    }));
    return new Response(stream, { status: response.status, headers: response.headers });
  });

  return app;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.issues.map((issue) => issue.message).join(" "));
  }
  return parsed.data;
}

function fail(c: { json: (body: unknown, status?: number) => Response }, error: unknown): Response {
  if (error instanceof HttpError) {
    return c.json({ error: error.message, issues: error.issues }, error.status);
  }
  console.error(error);
  return c.json({ error: "Internal server error" }, 500);
}
