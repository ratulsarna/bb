#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { resolveCurrentDevInstanceConfig } from "../packages/config/src/runtime.ts";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const SEEDED_USER_ID = "usr_cloud_dev";
const BASE_DOMAIN = "localhost";
const STATE_DIR = path.join(REPO_ROOT, ".wrangler", "cloud-dev");
const CONNECT_VARS_PATH = path.join(REPO_ROOT, "apps", "connect", ".dev.vars");
const WEB_VARS_PATH = path.join(REPO_ROOT, "apps", "web", ".dev.vars");
const DEV_INSTANCE = resolveCurrentDevInstanceConfig(REPO_ROOT);
const DEFAULT_CONNECT_PORT = DEV_INSTANCE.ports.cloudConnectPort;
const DEFAULT_WEB_PORT = DEV_INSTANCE.ports.cloudWebPort;
const DEV_ENV_PATH = path.join(DEV_INSTANCE.dataDir, "env.json");
const CONNECT_BASE_URL_ENV_NAME = "BB_CONNECT_BASE_URL";
const CONNECT_LOOPBACK_URL_ENV_NAME = "BB_CONNECT_LOOPBACK_URL";
const BB_APP_SOURCE_BIN = path.join(
  REPO_ROOT,
  "packages",
  "bb-app",
  "src",
  "bin",
  "bb-app.ts",
);

function fail(message) {
  console.error(`bb Cloud dev: ${message}`);
  process.exit(1);
}

function parsePort(value, flag) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    fail(`${flag} must be an integer between 1 and 65535`);
  }
  return port;
}

function parseArgs(argv) {
  let connectPort = DEFAULT_CONNECT_PORT;
  let webPort = DEFAULT_WEB_PORT;
  let githubAuth = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: pnpm cloud:dev [-- --connect-port <port> --web-port <port> --github-auth]

Starts apps/connect and apps/web against one local D1 database.

Options:
  --connect-port <port>  Connect worker port (this worktree: ${DEFAULT_CONNECT_PORT})
  --web-port <port>      Cloud account web port (this worktree: ${DEFAULT_WEB_PORT})
  --github-auth          Authenticate with a local GitHub OAuth App instead of
                         the seeded local developer account`);
      process.exit(0);
    }
    if (arg === "--github-auth") {
      githubAuth = true;
      continue;
    }
    if (arg === "--connect-port" || arg === "--web-port") {
      const value = argv[index + 1];
      if (value === undefined) fail(`${arg} requires a value`);
      if (arg === "--connect-port") connectPort = parsePort(value, arg);
      else webPort = parsePort(value, arg);
      index += 1;
      continue;
    }
    fail(`unknown option: ${arg}; run pnpm cloud:dev -- --help for usage`);
  }
  if (connectPort === webPort) fail("Connect and web ports must be different");
  return { connectPort, webPort, githubAuth };
}

async function assertPortAvailable(port, label) {
  await new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", (error) => reject(error));
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  }).catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${label} port ${port} is unavailable (${detail})`);
  });
}

async function findEphemeralLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(
          new Error("could not allocate the internal Connect worker port"),
        );
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function proxyHeaders(request, routingToken) {
  let routingLabel = "";
  try {
    const hostname = new URL(`http://${request.headers.host ?? ""}`).hostname;
    const suffix = `.${BASE_DOMAIN}`;
    if (hostname.endsWith(suffix)) {
      const candidate = hostname.slice(0, -suffix.length);
      if (candidate && !candidate.includes(".")) routingLabel = candidate;
    }
  } catch {
    // The Worker returns its ordinary unknown-host response.
  }
  return {
    ...request.headers,
    "x-bb-cloud-dev-routing-label": routingLabel,
    "x-bb-cloud-dev-token": routingToken,
  };
}

function writeUpgradeHead(socket, response) {
  const statusLine = `HTTP/1.1 ${response.statusCode ?? 500} ${response.statusMessage ?? ""}\r\n`;
  const rawHeaders = [];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    rawHeaders.push(
      `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`,
    );
  }
  socket.write(`${statusLine}${rawHeaders.join("\r\n")}\r\n\r\n`);
}

async function startConnectLoopbackProxy({
  publicPort,
  workerPort,
  routingToken,
}) {
  const proxy = createHttpServer((request, response) => {
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: workerPort,
        method: request.method,
        path: request.url,
        headers: proxyHeaders(request, routingToken),
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.headers,
        );
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end("Connect worker is starting\n");
    });
    request.pipe(upstream);
  });

  proxy.on("upgrade", (request, socket, head) => {
    const upstreamRequest = httpRequest({
      hostname: "127.0.0.1",
      port: workerPort,
      method: request.method,
      path: request.url,
      headers: proxyHeaders(request, routingToken),
    });
    socket.on("error", () => upstreamRequest.destroy());
    upstreamRequest.on("upgrade", (response, upstreamSocket, upstreamHead) => {
      upstreamSocket.on("error", () => socket.destroy());
      writeUpgradeHead(socket, response);
      if (head.length > 0) upstreamSocket.write(head);
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      socket.pipe(upstreamSocket).pipe(socket);
    });
    upstreamRequest.on("response", (response) => {
      writeUpgradeHead(socket, response);
      response.pipe(socket);
    });
    upstreamRequest.on("error", () => socket.destroy());
    upstreamRequest.end();
  });

  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(publicPort, "127.0.0.1", resolve);
  });
  return proxy;
}

function parseDevVars(filePath) {
  const values = new Map();
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    const quote = value[0];
    if (
      (quote === '"' || quote === "'" || quote === "`") &&
      value.endsWith(quote)
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

function runPnpm(args, options = {}) {
  const result = spawnSync("pnpm", args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) {
    fail(`command failed: pnpm ${args.join(" ")}`);
  }
}

function readManagedDevEnvValue(key) {
  if (!existsSync(DEV_ENV_PATH)) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(DEV_ENV_PATH, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`could not read ${DEV_ENV_PATH} (${detail})`);
  }
  const value = parsed?.env?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    fail(`${key} in ${DEV_ENV_PATH} must be a string`);
  }
  return value;
}

function updateManagedDevEnv(action, key, value) {
  const commandArgs = [
    "--conditions=source",
    "--import",
    "tsx",
    BB_APP_SOURCE_BIN,
    "--data-dir",
    DEV_INSTANCE.dataDir,
    "--server-url",
    DEV_INSTANCE.serverUrl,
    "env",
    action,
    key,
  ];
  if (value !== undefined) commandArgs.push(value);
  const result = spawnSync(process.execPath, commandArgs, {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      detail.length > 0
        ? detail
        : `bb-app env ${action} exited with ${String(result.status)}`,
    );
  }
}

function seedDevUserSql() {
  const now = Date.now();
  return `INSERT INTO user (id, name, email, email_verified, github_login, created_at, updated_at) VALUES ('${SEEDED_USER_ID}', 'Local bb developer', 'cloud-dev@local.invalid', 1, 'localbb', ${now}, ${now}) ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`;
}

function spawnService(label, args, env = {}) {
  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(childEnv)) {
    if (value === undefined) delete childEnv[key];
  }
  const child = spawn("pnpm", args, {
    cwd: REPO_ROOT,
    detached: process.platform !== "win32",
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const [stream, writer] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    stream.setEncoding("utf8");
    let pending = "";
    stream.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) writer.write(`[${label}] ${line}\n`);
    });
    stream.on("end", () => {
      if (pending.length > 0) writer.write(`[${label}] ${pending}\n`);
    });
  }
  return child;
}

function stopService(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    // The process may have exited between the state check and the signal.
  }
}

async function waitForHttp(url, label, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited before becoming ready`);
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status < 500) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`${label} did not become ready within 30 seconds`);
}

const {
  connectPort: CONNECT_PORT,
  webPort: WEB_PORT,
  githubAuth: GITHUB_AUTH,
} = parseArgs(process.argv.slice(2));

if (!existsSync(CONNECT_VARS_PATH)) {
  fail(
    "apps/connect/.dev.vars is missing; add OPENAI_API_KEY and BETTER_AUTH_SECRET first",
  );
}
const connectVars = parseDevVars(CONNECT_VARS_PATH);
for (const key of ["OPENAI_API_KEY", "BETTER_AUTH_SECRET"]) {
  const value = connectVars.get(key);
  if (!value || value.startsWith("replace-with-"))
    fail(`${key} is missing or still a placeholder in apps/connect/.dev.vars`);
}

let githubClientId = "local-cloud-dev-unused";
let githubClientSecret = "local-cloud-dev-unused";
if (GITHUB_AUTH) {
  if (!existsSync(WEB_VARS_PATH)) {
    fail(
      "apps/web/.dev.vars is missing; copy .dev.vars.example and add the local GitHub OAuth credentials",
    );
  }
  const webVars = parseDevVars(WEB_VARS_PATH);
  githubClientId = webVars.get("GITHUB_CLIENT_ID") ?? "";
  githubClientSecret = webVars.get("GITHUB_CLIENT_SECRET") ?? "";
  for (const [key, value] of [
    ["GITHUB_CLIENT_ID", githubClientId],
    ["GITHUB_CLIENT_SECRET", githubClientSecret],
  ]) {
    if (!value || value.startsWith("replace-with-")) {
      fail(`${key} is missing or still a placeholder in apps/web/.dev.vars`);
    }
  }
}

await Promise.all([
  assertPortAvailable(CONNECT_PORT, "Connect"),
  assertPortAvailable(WEB_PORT, "web"),
]);
const CONNECT_WORKER_PORT = await findEphemeralLoopbackPort();
const DEV_ROUTING_TOKEN = randomBytes(32).toString("hex");
const managedDevEnv = [
  {
    key: CONNECT_BASE_URL_ENV_NAME,
    value: `http://127.0.0.1:${WEB_PORT}`,
  },
  {
    key: CONNECT_LOOPBACK_URL_ENV_NAME,
    value: `http://127.0.0.1:${DEV_INSTANCE.ports.appPort}`,
  },
];
const previousManagedDevEnv = new Map(
  managedDevEnv.map(({ key }) => [key, readManagedDevEnvValue(key)]),
);
await mkdir(STATE_DIR, { recursive: true });

console.log(`Preparing shared local D1 at ${STATE_DIR}`);
runPnpm(
  [
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
  ],
  { env: { CI: "1" } },
);

if (!GITHUB_AUTH) {
  runPnpm([
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
    seedDevUserSql(),
  ]);
}

const connect = spawnService("connect", [
  "--filter",
  "@bb/connect",
  "exec",
  "wrangler",
  "dev",
  "--port",
  String(CONNECT_WORKER_PORT),
  "--ip",
  "127.0.0.1",
  "--host",
  "getbb.app",
  "--persist-to",
  STATE_DIR,
  "--var",
  `BASE_DOMAIN:${BASE_DOMAIN}`,
  "--var",
  `ACCOUNT_APP_URL:http://127.0.0.1:${WEB_PORT}`,
  ...(GITHUB_AUTH ? [] : ["--var", `DEV_AUTH_USER_ID:${SEEDED_USER_ID}`]),
  "--var",
  `DEV_ROUTING_TOKEN:${DEV_ROUTING_TOKEN}`,
  "--var",
  "BETTER_AUTH_SESSION_COOKIE_NAME:better-auth.session_token",
  "--show-interactive-dev-session=false",
]);

const connectProxy = await startConnectLoopbackProxy({
  publicPort: CONNECT_PORT,
  workerPort: CONNECT_WORKER_PORT,
  routingToken: DEV_ROUTING_TOKEN,
});

const web = spawnService(
  "web",
  [
    "--filter",
    "@bb/web",
    "exec",
    "vite",
    "dev",
    "--host",
    "0.0.0.0",
    "--port",
    String(WEB_PORT),
  ],
  {
    BB_CLOUD_DEV_APP_URL: `http://127.0.0.1:${WEB_PORT}`,
    BB_CLOUD_DEV_BASE_DOMAIN: BASE_DOMAIN,
    BB_CLOUD_DEV_CONNECT_SERVER_URL_TEMPLATE: `http://{label}.${BASE_DOMAIN}:${CONNECT_PORT}`,
    BB_CLOUD_DEV_STATE_PATH: STATE_DIR,
    BETTER_AUTH_SECRET: connectVars.get("BETTER_AUTH_SECRET"),
    CLOUDFLARE_ENV: "production",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
    GITHUB_CLIENT_ID: githubClientId,
    GITHUB_CLIENT_SECRET: githubClientSecret,
    DEV_AUTH_USER_ID: GITHUB_AUTH ? undefined : SEEDED_USER_ID,
    LANDING_POSTHOG_KEY: "local-cloud-dev-unused",
    RESEND_API_KEY: "local-cloud-dev-unused",
  },
);

let stopping = false;
const appliedManagedDevEnvKeys = [];

function restoreManagedDevEnv() {
  while (appliedManagedDevEnvKeys.length > 0) {
    const key = appliedManagedDevEnvKeys.pop();
    try {
      const previousValue = previousManagedDevEnv.get(key);
      if (previousValue === undefined) {
        updateManagedDevEnv("unset", key);
      } else {
        updateManagedDevEnv("set", key, previousValue);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`Could not restore ${key} in the dev server: ${detail}`);
    }
  }
}

function stopAll(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  restoreManagedDevEnv();
  connectProxy.close();
  connectProxy.closeAllConnections();
  stopService(connect);
  stopService(web);
  setTimeout(() => process.exit(exitCode), 100);
}
process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
connect.on("exit", (exitCode) => {
  if (!stopping) {
    console.error(`Connect worker exited with code ${exitCode ?? "unknown"}`);
    stopAll(exitCode ?? 1);
  }
});
web.on("exit", (exitCode) => {
  if (!stopping) {
    console.error(`Web worker exited with code ${exitCode ?? "unknown"}`);
    stopAll(exitCode ?? 1);
  }
});

try {
  await Promise.all([
    waitForHttp(
      `http://127.0.0.1:${CONNECT_PORT}/api/connect/servers`,
      "Connect worker",
      connect,
    ),
    waitForHttp(
      `http://127.0.0.1:${WEB_PORT}/api/connect/redeem`,
      "Web worker",
      web,
    ),
  ]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  stopAll(1);
  await new Promise(() => {});
}

try {
  for (const { key, value } of managedDevEnv) {
    updateManagedDevEnv("set", key, value);
    appliedManagedDevEnvKeys.push(key);
  }
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(
    `Could not configure the dev server's Cloud environment: ${detail}`,
  );
  stopAll(1);
  await new Promise(() => {});
}

const authInstructions = GITHUB_AUTH
  ? `Auth:           GitHub OAuth
  dashboard:      http://127.0.0.1:${WEB_PORT}/dashboard

Sign in with GitHub, claim a handle, and create a bb from the dashboard. The
OAuth callback registered at GitHub should omit the dynamic loopback port:
  http://127.0.0.1/api/auth/callback/github
This run redirects back to:
  http://127.0.0.1:${WEB_PORT}/api/auth/callback/github`
  : `Auth:           local developer identity
  dashboard:      http://127.0.0.1:${WEB_PORT}/dashboard

Open the dashboard, choose a handle, and create your first bb. Generate its
pairing code there, then enter that code in the app:
  http://localhost:${DEV_INSTANCE.ports.appPort}/settings/plugins/connect

After pairing, enable Cloud AI from another terminal if you are testing it:
  eval "$(scripts/bb-dev-app env)"
  unset BB_CLI BB_CLI_REEXEC
  pnpm bb:dev settings experiment cloudAi true
  pnpm bb:dev connect ai on
  pnpm bb:dev connect status`;

console.log(`
Local bb Cloud is ready:
  apps/web:     http://127.0.0.1:${WEB_PORT}
  apps/connect: http://127.0.0.1:${CONNECT_PORT}
  bb URLs:      http://<handle>.localhost:${CONNECT_PORT}

${authInstructions}

Press Ctrl-C to stop both Cloud workers and restore the dev server's previous
${CONNECT_BASE_URL_ENV_NAME} and ${CONNECT_LOOPBACK_URL_ENV_NAME} settings.
`);

await new Promise(() => {});
