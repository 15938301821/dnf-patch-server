import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";

const host = "127.0.0.1";
const apiPort = await findFreePort();
const databasePort = await findFreePort();
const clientToken = randomBytes(24).toString("hex");
const workerToken = randomBytes(24).toString("hex");
const browserSessionSecret = randomBytes(32).toString("hex");
const environment = {
  ...process.env,
  NODE_ENV: "test",
  HOST: host,
  PORT: String(apiPort),
  CORS_ORIGINS: "http://127.0.0.1:3000",
  DATABASE_URL: `mysql://runtime-probe@${host}:${String(databasePort)}/dnf_patch`,
  DATABASE_POOL_SIZE: "1",
  DNF_REPOSITORY_ROOT: "../dnf-patch",
  CLIENT_SHARED_TOKEN: clientToken,
  WORKER_SHARED_TOKEN: workerToken,
  BROWSER_SESSION_SECRET: browserSessionSecret,
  OPENAI_BASE_URL: "https://kldai.cc/v1",
  OPENAI_ORCHESTRATOR_MODEL: "gpt-5.6-sol",
  OPENAI_ENGINEER_MODEL: "gpt-5.5",
  OPENAI_IMAGE_MODEL: "gpt-image-2",
  WORKER_LEASE_SECONDS: "60",
};

const child = spawn(process.execPath, [resolve("dist/main.js")], {
  cwd: process.cwd(),
  env: environment,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let output = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    output = `${output}${String(chunk)}`.slice(-20_000);
  });
}

try {
  const health = await waitForHealth(child, apiPort);
  if (
    health.schemaVersion !== 1 ||
    health.status !== "degraded" ||
    health.service !== "dnf-patch-server" ||
    health.database !== "unavailable"
  ) {
    throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
  }
  const protectedResponse = await fetch(
    `http://${host}:${String(apiPort)}/v1/projects`,
    { signal: AbortSignal.timeout(2_000) },
  );
  if (protectedResponse.status !== 401) {
    throw new Error(
      `Unauthenticated project request returned ${String(protectedResponse.status)}.`,
    );
  }
  const corsOrigin = "http://127.0.0.1:3000";
  const preflightResponse = await fetch(
    `http://${host}:${String(apiPort)}/v1/auth/refresh`,
    {
      method: "OPTIONS",
      headers: {
        Origin: corsOrigin,
        "Access-Control-Request-Method": "POST",
      },
      signal: AbortSignal.timeout(2_000),
    },
  );
  if (
    preflightResponse.status !== 204 ||
    preflightResponse.headers.get("access-control-allow-origin") !==
      corsOrigin ||
    preflightResponse.headers.get("access-control-allow-credentials") !== "true"
  ) {
    throw new Error(
      "Credentialed CORS preflight did not preserve the allowlist.",
    );
  }
  process.stdout.write(
    `${JSON.stringify({ status: "passed", healthStatus: health.status, database: health.database, unauthenticatedProjectsStatus: protectedResponse.status, credentialedCorsOrigin: corsOrigin }, null, 2)}\n`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`${message}\nProduction process output:\n${output}`);
} finally {
  await stopChild(child);
}

async function findFreePort() {
  const server = createServer();
  server.unref();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, host, resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a runtime probe port.");
  }
  const port = address.port;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return port;
}

async function waitForHealth(processHandle, port) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(
        `Production process exited with code ${String(processHandle.exitCode)}.`,
      );
    }
    try {
      const response = await fetch(`http://${host}:${String(port)}/v1/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Startup races are retried until the bounded deadline.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(
    "Production service did not become healthy within 12 seconds.",
  );
}

async function stopChild(processHandle) {
  if (hasExited(processHandle)) return;
  const gracefulExit = once(processHandle, "exit");
  processHandle.kill();
  await Promise.race([
    gracefulExit,
    new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000)),
  ]);
  if (!hasExited(processHandle)) {
    const forcedExit = once(processHandle, "exit");
    processHandle.kill("SIGKILL");
    await Promise.race([
      forcedExit,
      new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000)),
    ]);
  }
  if (!hasExited(processHandle)) {
    throw new Error("Production smoke process did not stop within 6 seconds.");
  }
}

function hasExited(processHandle) {
  return processHandle.exitCode !== null || processHandle.signalCode !== null;
}
