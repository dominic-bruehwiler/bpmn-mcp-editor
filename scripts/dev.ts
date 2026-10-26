/** Starts the API and the Vite dev server together. */
import { spawn } from "node:child_process";

const setup = spawn("bun", ["scripts/db.ts"], { stdio: "inherit" });

setup.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);

  const server = spawn("bun", ["--hot", "src/server/index.ts"], { stdio: "inherit" });
  const web = spawn("bunx", ["vite", "--host", "127.0.0.1"], { stdio: "inherit" });

  const stop = () => {
    server.kill("SIGTERM");
    web.kill("SIGTERM");
  };
  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGTERM", stop);
});
