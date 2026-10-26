# BPMN MCP Editor

**Version 0.1.0** · Early release

A Camunda 7 BPMN editor you can use in the browser and drive from AI agents over the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). The web UI is built on [bpmn.io](https://bpmn.io/) (palette, properties panel, Camunda extensions). Agents edit the same diagrams through structured MCP tools—not raw XML. Browser and agent share one database, with optimistic locking so the canvas stays consistent.

## Features

- **Browser modeler** — Full BPMN editing with Camunda 7 fields via `bpmn-js` and the properties panel.
- **MCP server** — stdio (e.g. Cursor) or HTTP; semantic operations (`add_elements`, `connect_elements`, `update_element`, `delete_element`, `batch_edit`, and more).
- **Shared state** — Changes from the agent appear in the browser (polling); user edits and agent locks are coordinated.
- **Validation** — `build` profile while designing; stricter `deploy` profile for Camunda 7 readiness (start/end events, labels, `historyTimeToLive`, etc.).
- **Auto-layout** — Optional layout pass for readable diagrams.
- **SQLite by default** — PostgreSQL supported for production-style setups.

## How it works

```text
┌─────────────┐     REST / SSE      ┌──────────────────┐     Prisma      ┌──────────┐
│  Web UI     │ ◄──────────────────►│  Hono API        │ ◄──────────────►│ SQLite / │
│  (Vite)     │                     │  + MCP (HTTP)    │                 │ Postgres │
└─────────────┘                     └────────▲─────────┘                 └──────────┘
                                             │
                                    stdio MCP │ (Cursor, CLI)
                                             │
                                      ┌──────┴──────┐
                                      │ AI agent    │
                                      └─────────────┘
```

1. You run the dev or production server (API on port **3001**, web UI on **5173** in development).
2. The browser loads processes from the API and saves user edits with revision checks.
3. An MCP client connects via **stdio** or **HTTP** and uses tools such as `create_process`, `acquire_lock`, and `batch_edit`.
4. While an agent holds a lock, the canvas is read-only in the browser; locks expire after inactivity.

On first start, a sample process **Invoice approval** is seeded in the database.

## Requirements

- [Bun](https://bun.sh/) (runtime and package manager)
- Modern browser for the editor

## Quick start

```bash
bun install
bun run dev
```

| Service        | URL |
|----------------|-----|
| Editor (dev)   | [http://127.0.0.1:5173](http://127.0.0.1:5173) |
| API + MCP HTTP | [http://127.0.0.1:3001](http://127.0.0.1:3001) |

Production:

```bash
bun run build
bun run start
```

## MCP configuration

### stdio (Cursor, project root)

```json
{
  "mcpServers": {
    "bpmn": {
      "command": "bun",
      "args": ["src/server/stdio.ts"]
    }
  }
}
```

The same configuration is available in [`.cursor/mcp.json`](.cursor/mcp.json). The web server must be running for agent changes to show up in the browser; the UI polls the database about once per second.

### HTTP

If the agent talks directly to the running server:

```text
http://127.0.0.1:3001/mcp
```

Optional: set `MCP_API_KEY` and send `Authorization: Bearer <key>` on HTTP MCP requests.

### Agent editing model

Agents work with **short, typed operations**, not free-form BPMN XML:

| Tool | Purpose |
|------|---------|
| `list_processes` | List stored processes |
| `create_process` | Create a diagram; returns `lockToken` and `revision` |
| `get_process` | Read metadata and XML |
| `acquire_lock` / `release_lock` | Exclusive edit session |
| `add_elements` | Add BPMN elements (tasks, gateways, events, …) |
| `connect_elements` | Sequence/message flows |
| `update_element` / `delete_element` | Patch or remove elements |
| `batch_edit` | Multiple ops in one revision |
| `auto_layout` | Run automatic layout |
| `validate_process` | Lint with `build` or `deploy` profile |
| `import_bpmn` / `delete_process` | Import XML or remove a process |

`create_process` acquires a lock and returns `lockToken` plus `revision`. Every mutating call needs both. If the revision is stale or the result would be invalid BPMN, nothing is committed.

**Locking:** While locked, the canvas is read-only. A recent user edit blocks a new agent lock for a few seconds. The lock expires after **45 seconds** without further agent mutations.

**Validation:** `validate_process` with `profile: "deploy"` checks Camunda 7 deploy readiness. During construction, `profile: "build"` is looser (e.g. missing end events may be warnings); a service task without implementation is still an error.

## Database

Default: SQLite at `data/dev.db`.

PostgreSQL:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bpmn_editor bun run db:setup
```

`db:setup` switches the Prisma provider to `postgresql` and applies the schema. Restart the server afterward.

## Environment variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Prisma connection string (SQLite file URL or Postgres) |
| `MCP_API_KEY` | Optional bearer token for HTTP MCP |
| `NODE_ENV` | Set to `production` for `bun run start` |

## Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Vite + API dev servers |
| `bun run build` | Production web build |
| `bun run start` | Production API (serves built UI) |
| `bun run mcp` | MCP stdio entrypoint |
| `bun run db:setup` | Generate client / migrate schema |
| `bun run test` | Test suite |
| `bun run typecheck` | TypeScript check |

## Third-party notices

This application bundles many open-source libraries (MIT, Apache-2.0, BSD, ISC, and others). Notable obligations:

- **[bpmn-js](https://github.com/bpmn-io/bpmn-js)** (MIT) — The [bpmn.io](https://bpmn.io/) watermark in rendered diagrams must not be removed or obscured.
- **Geist** (OFL-1.1) via `@fontsource-variable/geist` — Keep font license notices when redistributing builds.

A full `THIRD-PARTY-NOTICES` file is recommended before public distribution.

## License

**BPMN MCP Editor** is licensed under the **[GNU Affero General Public License v3.0 or later](LICENSE)** ([AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html)).

You may use, modify, and redistribute this software for any purpose, including **commercial use**, as long as you comply with the AGPL. In particular:

- If you **distribute** copies or modified versions, you must provide corresponding source under the same license.
- If you **modify** this program and run it on a server so users interact with it over a network (for example, a hosted editor or HTTP MCP endpoint at `/mcp`), you must offer those users the corresponding source of your version ([AGPL section 13](https://www.gnu.org/licenses/agpl-3.0.html#section13)).

Redistribution and commercial hosting are allowed under these terms; they are not a substitute for a separate commercial license if you need terms outside the AGPL.

### Dependency compliance (summary)

Production dependencies are overwhelmingly MIT, ISC, Apache-2.0, and BSD. When you distribute this application, preserve third-party copyright notices and honor [bpmn-js](https://bpmn.io/legal/terms/) (watermark) and font attribution requirements. See [Third-party notices](#third-party-notices) above.

---

## Disclaimer

THE SOFTWARE IS PROVIDED **“AS IS”**, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT, OR OTHERWISE, ARISING FROM, OUT OF, OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

BPMN diagrams and process definitions created with this tool are your responsibility. This project is not affiliated with Camunda GmbH. Camunda 7 compatibility is best-effort via community tooling (`camunda-bpmn-moddle`, lint plugins); always validate in your target environment before production deployment.

Nothing in this README constitutes legal advice. Have qualified counsel review licensing before public release.

## Contributing

Contributions are welcome once the repository is public. Please open an issue before large changes. Run `bun run test` and `bun run typecheck` before submitting a pull request.

## Status

v0.1.0 is an early release: APIs, MCP tools, and database schema may change. Use in production at your own risk.
