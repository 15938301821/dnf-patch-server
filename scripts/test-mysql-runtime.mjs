import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  exerciseApi,
  verifyPersistence,
} from "./runtime-test/api-scenario.mjs";
import {
  connectDatabase,
  createDatabase,
  initializeMysql,
  inspectDatabaseState,
  inspectSchema,
  startMysql,
  waitForMysql,
} from "./runtime-test/database.mjs";
import {
  assert,
  assertRunning,
  delay,
  errorMessage,
  findFreePort,
  processFailure,
  resolveMysqlIdentity,
  runProcess,
  startProcess,
  stopChild,
  stopMysql,
} from "./runtime-test/process.mjs";

const host = "127.0.0.1";
let sandboxPath;
let mysqlProcess;
let appProcess;
let database;
let mysqlIdentity;
let databasePort;
let primaryError;
let result;
const cleanupErrors = [];

try {
  mysqlIdentity = await resolveMysqlIdentity();
  databasePort = await findFreePort();
  const apiPort = await findFreePort();
  sandboxPath = await mkdtemp(join(tmpdir(), "dnf-patch-mysql-runtime-"));
  const dataPath = join(sandboxPath, "data");
  await initializeMysql(mysqlIdentity, dataPath);
  mysqlProcess = startMysql(mysqlIdentity, dataPath, databasePort, sandboxPath);
  await waitForMysql(mysqlProcess, databasePort);

  const databaseUrl = await createDatabase(databasePort);
  await runProcess(process.execPath, [resolve("dist/common/db/migrate.js")], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeoutMs: 60_000,
  });
  database = await connectDatabase(databasePort);
  const schema = await inspectSchema(database);

  const clientToken = randomBytes(32).toString("hex");
  const workerToken = randomBytes(32).toString("hex");
  const applicationEnvironment = createApplicationEnvironment({
    apiPort,
    databaseUrl,
    clientToken,
    workerToken,
  });
  appProcess = startApplication(applicationEnvironment);
  const health = await waitForApplication(appProcess, apiPort);
  const scenario = await exerciseApi({ apiPort, clientToken, workerToken });
  await stopChild(appProcess, "Production service");
  appProcess = undefined;

  appProcess = startApplication(applicationEnvironment);
  await waitForApplication(appProcess, apiPort);
  const persistence = await verifyPersistence({
    apiPort,
    clientToken,
    runId: scenario.runId,
    projectId: scenario.projectId,
  });
  const databaseState = await inspectDatabaseState(database, scenario);
  result = {
    status: "passed",
    mysql: {
      version: mysqlIdentity.version,
      executableSha256: mysqlIdentity.sha256,
      isolatedPort: databasePort,
      usedSystemPort3306: false,
    },
    schema,
    health,
    authentication: scenario.authentication,
    run: {
      idempotentCreate: scenario.idempotentCreate,
      persistedAfterRestart: persistence.persistedAfterRestart,
      statusAfterJobCompletion: databaseState.status,
      deploymentAuthorized: Boolean(databaseState.deploymentAuthorized),
      deploymentPerformed: Boolean(databaseState.deploymentPerformed),
      fullSkillCoverageProven: Boolean(databaseState.fullSkillCoverageProven),
      clientCompatibilityProven: Boolean(
        databaseState.clientCompatibilityProven,
      ),
    },
    worker: scenario.worker,
    webSocket: {
      ...persistence.webSocket,
      liveEventsReceived: scenario.liveEventsReceived,
    },
    rows: databaseState.rows,
  };
} catch (error) {
  primaryError = error;
} finally {
  await cleanup("production service", async () => {
    if (appProcess) await stopChild(appProcess, "Production service");
  });
  await cleanup("database connection", async () => {
    if (database) await database.end();
  });
  await cleanup("isolated MySQL", async () => {
    if (mysqlProcess && mysqlIdentity && databasePort) {
      await stopMysql(mysqlProcess, mysqlIdentity, databasePort);
    }
  });
  await cleanup("temporary database directory", async () => {
    if (sandboxPath) {
      await rm(sandboxPath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    }
  });
}

if (primaryError || cleanupErrors.length > 0) {
  const messages = [
    ...(primaryError ? [errorMessage(primaryError)] : []),
    ...cleanupErrors,
  ];
  throw new Error(messages.join("\n"));
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function createApplicationEnvironment({
  apiPort,
  databaseUrl,
  clientToken,
  workerToken,
}) {
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    HOST: host,
    PORT: String(apiPort),
    CORS_ORIGINS: "http://127.0.0.1:5173",
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_SIZE: "2",
    DNF_REPOSITORY_ROOT: resolve("../dnf-patch"),
    CLIENT_SHARED_TOKEN: clientToken,
    WORKER_SHARED_TOKEN: workerToken,
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENAI_ORCHESTRATOR_MODEL: "gpt-5.6-sol",
    OPENAI_ENGINEER_MODEL: "gpt-5.5",
    OPENAI_IMAGE_MODEL: "gpt-image-2",
    WORKER_LEASE_SECONDS: "60",
  };
  delete environment.OPENAI_API_KEY;
  return environment;
}

function startApplication(environment) {
  return startProcess(process.execPath, [resolve("dist/main.js")], {
    cwd: process.cwd(),
    env: environment,
  });
}

async function waitForApplication(processHandle, port) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    assertRunning(processHandle, "Production service");
    try {
      const response = await fetch(`http://${host}:${String(port)}/v1/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok) {
        const health = await response.json();
        assert(health.status === "ok", "MySQL-backed health must be ok.");
        assert(
          health.database === "available",
          "MySQL-backed health must report an available database.",
        );
        return { status: health.status, database: health.database };
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("must be ok") ||
          error.message.includes("available database"))
      ) {
        throw error;
      }
    }
    await delay(100);
  }
  throw processFailure(
    processHandle,
    "Production service did not start in 15 seconds.",
  );
}

async function cleanup(label, action) {
  try {
    await action();
  } catch (error) {
    cleanupErrors.push(`Failed to clean up ${label}: ${errorMessage(error)}`);
  }
}
