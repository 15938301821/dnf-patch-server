/**
 * @fileoverview 编排 Server 的隔离 MySQL 运行时集成门禁；不使用系统 3306、生产数据库、真实对象存储、外部模型或 Worker 工具链。
 * @module scripts/test-mysql-runtime
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：由 npm test:mysql 入口直接执行；下游协调 database、API、outbox、模型恢复、migration 预检和重启持久化场景，并启动 dist/main.js 两次。
 * 输入：本机受支持的 mysqld 身份和当前生产构建；脚本自行生成临时目录、回环端口及随机 Client/Worker token。输出：向 stdout 写入 schema、认证、Run/Job、事件与恢复行为的脱敏证明摘要。
 * 副作用：创建并删除临时 MySQL data directory，执行真实 migration 和测试 SQL，启动/停止数据库与 Server 子进程，并建立短期 HTTP/Socket 连接。
 * 安全/验证边界：所有服务仅绑定回环且不接触系统实例；清理错误与主场景错误同时保留。通过只证明当前隔离 MySQL 场景，不证明外部模型、MinIO、真实 Worker、客户端兼容或部署。
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exerciseApi } from "./runtime-test/api-scenario.mjs";
import {
  restorePublishedRunEventToPending,
  waitForRunOutboxDrained,
  waitForRunOutboxReplay,
} from "./runtime-test/outbox-scenario.mjs";
import {
  insertStaleModelCall,
  verifyStaleModelCallRecovered,
} from "./runtime-test/model-recovery-scenario.mjs";
import { exerciseMigrationPreflight } from "./runtime-test/migration-preflight-scenario.mjs";
import { verifyPersistence } from "./runtime-test/persistence-scenario.mjs";
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
  // 步骤 1：识别受信 mysqld，并在临时目录和回环空闲端口上建立隔离数据库实例。
  mysqlIdentity = await resolveMysqlIdentity();
  databasePort = await findFreePort();
  const apiPort = await findFreePort();
  sandboxPath = await mkdtemp(join(tmpdir(), "dnf-patch-mysql-runtime-"));
  const dataPath = join(sandboxPath, "data");
  await initializeMysql(mysqlIdentity, dataPath);
  mysqlProcess = startMysql(mysqlIdentity, dataPath, databasePort, sandboxPath);
  await waitForMysql(mysqlProcess, databasePort);

  // 步骤 2：对空数据库执行真实 migration，再核验表、约束和升级前置条件。
  const databaseUrl = await createDatabase(databasePort);
  await runProcess(process.execPath, [resolve("dist/common/db/migrate.js")], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeoutMs: 60_000,
  });
  database = await connectDatabase(databasePort);
  const schema = await inspectSchema(database);
  const migrationPreflight = await exerciseMigrationPreflight(databasePort);

  // 步骤 3：使用随机且相互隔离的 Client/Worker 凭据启动服务，运行主 API 与租约场景。
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
  const scenario = await exerciseApi({
    apiPort,
    clientToken,
    workerToken,
    database,
  });
  await waitForRunOutboxDrained(database);
  await stopChild(appProcess, "Production service");
  appProcess = undefined;
  // 步骤 4：把 outbox 和运行中的模型调用构造成可恢复状态，随后重启服务验证后台恢复。
  const replayOutboxId = await restorePublishedRunEventToPending(
    database,
    scenario.runId,
  );
  const staleModelCallId = await insertStaleModelCall(database, scenario.runId);

  appProcess = startApplication({
    ...applicationEnvironment,
    WORKER_REAPER_INTERVAL_MS: "1000",
  });
  await waitForApplication(appProcess, apiPort);
  const outbox = await waitForRunOutboxReplay(database, replayOutboxId);
  const modelRecovery = await verifyStaleModelCallRecovered(
    database,
    staleModelCallId,
  );
  const persistence = await verifyPersistence({
    apiPort,
    clientToken,
    runId: scenario.runId,
    projectId: scenario.projectId,
    retryRunId: scenario.retryRunId,
    integrityRunId: scenario.integrityRunId,
  });
  const databaseState = await inspectDatabaseState(database, scenario);
  // 步骤 5：只汇总已由断言证明且不含 token、连接串或载荷正文的结果。
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
      concurrentIdempotentCreate: scenario.concurrentIdempotentCreate,
      idempotencyConflictRejected: scenario.idempotencyConflictRejected,
      clientRunIdConflictRejected: scenario.clientRunIdConflictRejected,
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
    evidence: scenario.evidence,
    reaper: persistence.reaper,
    integrity: persistence.integrity,
    webSocket: {
      ...persistence.webSocket,
      liveEventsReceived: scenario.liveEventsReceived,
    },
    outbox,
    modelRecovery,
    migrationPreflight,
    rows: databaseState.rows,
  };
} catch (error) {
  primaryError = error;
} finally {
  // 各清理动作独立收集错误，确保前一项失败不会阻止后续进程和临时目录继续回收。
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

/**
 * 构造隔离 Server 子进程环境，固定测试端点、调度周期与数据库连接。
 *
 * @param apiPort 已探测的回环 API 端口。
 * @param databaseUrl 指向本脚本临时 MySQL 实例的连接串，只传入子进程环境。
 * @param clientToken 随机 Client 共享 token，用于普通测试请求。
 * @param workerToken 与 Client token 不同的随机 Worker token，用于内部 Job 请求。
 * @returns 可传给 startProcess 的环境对象；不会写回父进程环境。
 */
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
    CORS_ORIGINS: "http://127.0.0.1:3000",
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_SIZE: "2",
    DNF_REPOSITORY_ROOT: resolve("../dnf-patch"),
    CLIENT_SHARED_TOKEN: clientToken,
    WORKER_SHARED_TOKEN: workerToken,
    BROWSER_SESSION_SECRET: randomBytes(32).toString("hex"),
    OPENAI_BASE_URL: "https://kldai.cc/v1",
    OPENAI_ORCHESTRATOR_MODEL: "gpt-5.6-sol",
    OPENAI_ENGINEER_MODEL: "gpt-5.5",
    OPENAI_IMAGE_MODEL: "gpt-image-2",
    OUTBOX_DISPATCH_INTERVAL_MS: "100",
    OUTBOX_DISPATCH_BATCH_SIZE: "25",
    WORKER_LEASE_SECONDS: "60",
    WORKER_REAPER_INTERVAL_MS: "60000",
    WORKER_REAPER_BATCH_SIZE: "25",
  };
  return environment;
}

/**
 * 使用指定隔离环境启动已构建的 Server 入口。
 *
 * @param environment 由 createApplicationEnvironment 生成的完整子进程环境。
 * @returns 由 process helper 管理并捕获有界输出的子进程句柄。
 */
function startApplication(environment) {
  return startProcess(process.execPath, [resolve("dist/main.js")], {
    cwd: process.cwd(),
    env: environment,
  });
}

/**
 * 等待 MySQL 支撑的 Server 达到可用状态，并拒绝把 degraded 当作集成成功。
 *
 * @param processHandle 当前生产构建子进程，用于检测提前退出并生成脱敏失败摘要。
 * @param port Server 绑定的回环端口。
 * @returns 已确认 status=ok、database=available 的最小健康摘要。
 * @throws 服务提前退出、健康字段不符或 15 秒内未启动时抛出。
 */
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

/**
 * 执行一项清理动作并收集失败原因，使后续资源仍有机会释放。
 *
 * @param label 写入最终错误摘要的资源名称，不包含凭据或绝对临时路径。
 * @param action 关闭连接、停止进程或删除临时目录的异步动作。
 * @returns 动作成功或错误已加入 cleanupErrors 后完成。
 */
async function cleanup(label, action) {
  try {
    await action();
  } catch (error) {
    cleanupErrors.push(`Failed to clean up ${label}: ${errorMessage(error)}`);
  }
}
