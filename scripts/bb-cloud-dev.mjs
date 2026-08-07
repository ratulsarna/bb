#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createProxyServer } from "http-proxy-3";
import { resolveCurrentDevInstanceConfig } from "../packages/config/src/runtime.ts";
import { CLOUD_DEV_HOST_HEADER } from "../apps/connect/src/cloud-dev.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const STATE_DIR = path.join(REPO_ROOT, ".wrangler", "cloud-dev");
const DEV_USER_ID = "usr_cloud_dev";
const DEV_SECRET = "bb-local-cloud-development";
const { ports } = resolveCurrentDevInstanceConfig(REPO_ROOT);
const CLOUD_URL = `http://localhost:${ports.cloudPort}`;
const WORKER_URL = `http://127.0.0.1:${ports.cloudWorkerPort}`;

function fail(message) {
  console.error(`bb Cloud dev: ${message}`);
  process.exit(1);
}

function run(args) {
  const result = spawnSync("pnpm", args, {
    cwd: REPO_ROOT,
    env: { ...process.env, CI: "1" },
    stdio: "inherit",
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) fail(`command failed: pnpm ${args.join(" ")}`);
}

function spawnService(args, env = {}) {
  return spawn("pnpm", args, {
    cwd: REPO_ROOT,
    detached: process.platform !== "win32",
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
}

function stopService(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    // The process may have exited while shutdown was starting.
  }
}

function routeRequest(request) {
  try {
    const hostname = new URL(`http://${request.headers.host ?? ""}`).hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      delete request.headers[CLOUD_DEV_HOST_HEADER];
      return { target: webUrl, changeOrigin: false };
    }
    if (hostname.endsWith(".localhost")) {
      const label = hostname.slice(0, -".localhost".length);
      if (label && !label.includes(".")) {
        request.headers[CLOUD_DEV_HOST_HEADER] = label;
        return { target: WORKER_URL, changeOrigin: true };
      }
    }
  } catch {
    // Invalid hosts are rejected below.
  }
  return null;
}

async function waitFor(url, host, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Cloud service exited early");
    try {
      const response = await fetch(url, {
        headers: { host },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status < 500) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`timed out waiting for ${host}`);
}

await mkdir(STATE_DIR, { recursive: true });
console.log(`Preparing local Cloud data in ${STATE_DIR}`);
run([
  "--filter",
  "@bb/connect",
  "exec",
  "wrangler",
  "d1",
  "migrations",
  "apply",
  "DB",
  "--local",
  "--persist-to",
  STATE_DIR,
]);

const now = Date.now();
const seedSql = `INSERT INTO user (id, name, email, email_verified, github_login, created_at, updated_at) VALUES ('${DEV_USER_ID}', 'Local bb developer', 'cloud-dev@local.invalid', 1, 'localbb', ${now}, ${now}) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`;
run([
  "--filter",
  "@bb/connect",
  "exec",
  "wrangler",
  "d1",
  "execute",
  "DB",
  "--local",
  "--persist-to",
  STATE_DIR,
  "--command",
  seedSql,
]);

const worker = spawnService([
  "--filter",
  "@bb/connect",
  "exec",
  "wrangler",
  "dev",
  "--port",
  String(ports.cloudWorkerPort),
  "--ip",
  "127.0.0.1",
  "--persist-to",
  STATE_DIR,
  "--var",
  "BASE_DOMAIN:localhost",
  "--var",
  `ACCOUNT_APP_URL:${CLOUD_URL}`,
  "--var",
  `BETTER_AUTH_SECRET:${DEV_SECRET}`,
  "--var",
  `DEV_AUTH_USER_ID:${DEV_USER_ID}`,
  "--show-interactive-dev-session=false",
]);

const webPort = ports.cloudWorkerPort + 8_000;
const webUrl = `http://127.0.0.1:${webPort}`;
const web = spawnService(
  [
    "--filter",
    "@bb/web",
    "exec",
    "vite",
    "dev",
    "--host",
    "127.0.0.1",
    "--port",
    String(webPort),
  ],
  {
    BB_CLOUD_DEV_APP_URL: CLOUD_URL,
    BB_CLOUD_DEV_AUTH_USER_ID: DEV_USER_ID,
    BB_CLOUD_DEV_SERVER_URL_TEMPLATE: `http://{label}.localhost:${ports.cloudPort}`,
    BB_CLOUD_DEV_STATE_PATH: STATE_DIR,
    BETTER_AUTH_SECRET: DEV_SECRET,
    CLOUDFLARE_ENV: "production",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
    GITHUB_CLIENT_ID: "local-cloud-dev-unused",
    GITHUB_CLIENT_SECRET: "local-cloud-dev-unused",
    LANDING_POSTHOG_KEY: "local-cloud-dev-unused",
    RESEND_API_KEY: "local-cloud-dev-unused",
  },
);

const proxy = createProxyServer({ ws: true });
const gateway = createServer((request, response) => {
  const route = routeRequest(request);
  if (route === null) {
    response.writeHead(404).end("Unknown local Cloud host\n");
    return;
  }
  proxy.web(request, response, route, () => {
    if (!response.headersSent) response.writeHead(502);
    response.end("Local Cloud service is starting\n");
  });
});
gateway.on("upgrade", (request, socket, head) => {
  const route = routeRequest(request);
  if (route === null) {
    socket.destroy();
    return;
  }
  proxy.ws(request, socket, head, route, () => socket.destroy());
});
await new Promise((resolve, reject) => {
  gateway.once("error", reject);
  gateway.listen(ports.cloudPort, "127.0.0.1", resolve);
});

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  gateway.close();
  stopService(worker);
  stopService(web);
  setTimeout(() => process.exit(exitCode), 100);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
for (const child of [worker, web]) {
  child.on("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
}

try {
  await Promise.all([
    waitFor(`${CLOUD_URL}/dashboard`, `localhost:${ports.cloudPort}`, web),
    waitFor(`${CLOUD_URL}/`, `probe.localhost:${ports.cloudPort}`, worker),
  ]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  stop(1);
  await new Promise(() => {});
}

console.log(`
Local bb Cloud is ready at ${CLOUD_URL}/dashboard

Claim a handle, generate a pairing code, and run the command shown in the
dashboard against a bb started with pnpm dev. Local handles use:
  http://<handle>.localhost:${ports.cloudPort}

Set OPENAI_API_KEY in apps/connect/.dev.vars only when testing the AI gateway.
Press Ctrl-C to stop local Cloud.
`);

await new Promise(() => {});
