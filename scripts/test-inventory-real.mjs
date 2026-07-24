/**
 * @fileoverview 编排官方 NPK、隔离 MySQL、私有 MinIO、生产 Server 与真实 Windows Worker 的
 * Inventory 端到端门禁；不连接系统 3306 或业务数据库，也不执行 Profession、部署或游戏进程操作。
 * @module scripts/test-inventory-real
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 用户直接要求整体真实数据测试
 *
 * 调用关系：`npm run test:inventory-real` 在两端构建后执行本脚本；下游协调 runtime database、
 * environment 与 scenario 模块。输入是显式固定工具路径/哈希，输出是脱敏 JSON 证据摘要。
 * 副作用：创建并删除临时 MySQL/MinIO 数据目录，启动两端生产构建，读取官方 NPK并上传两份
 * 派生 JSON 证据。安全边界：官方源始终只读；临时凭据不落库、不写日志；任一清理失败整体失败。
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  connectDatabase,
  createDatabase,
  initializeMysql,
  startMysql,
  waitForMysql,
} from "./runtime-test/database.mjs";
import {
  allocateRuntimePorts,
  configureMinio,
  createRuntimeSecrets,
  createServerEnvironment,
  createWorkerEnvironment,
  inspectSource,
  resolveRealInventoryInputs,
  startMinio,
  waitForMinio,
} from "./runtime-test/inventory-real-environment.mjs";
import {
  exerciseRealInventory,
  seedRealInventoryContext,
  waitForInventoryWorker,
  waitForRealServer,
} from "./runtime-test/inventory-real-scenario.mjs";
import {
  buildRealBrowser,
  inspectRealBrowserSession,
  registerRealBrowserUser,
  runRealBrowserScenario,
  startRealBrowserPreview,
  waitForRealBrowserPreview,
} from "./runtime-test/inventory-real-browser.mjs";
import {
  errorMessage,
  resolveMysqlIdentity,
  runProcess,
  startProcess,
  stopChild,
  stopMysql,
} from "./runtime-test/process.mjs";

let sandboxPath;
let mysqlProcess;
let minioProcess;
let serverProcess;
let workerProcess;
let browserProcess;
let database;
let mysqlIdentity;
let ports;
let primaryError;
let result;
const cleanupErrors = [];

try {
  // 步骤 1：在产生网络或数据库副作用前复核全部固定本机身份，并分配随机回环端口。
  const inputs = await resolveRealInventoryInputs();
  mysqlIdentity = await resolveMysqlIdentity();
  ports = await allocateRuntimePorts();
  const secrets = createRuntimeSecrets();
  sandboxPath = await mkdtemp(join(tmpdir(), "dnf-patch-inventory-real-"));
  const mysqlDataPath = join(sandboxPath, "mysql-data");
  const minioDataPath = join(sandboxPath, "minio-data");
  const minioConfigurationPath = join(sandboxPath, "mc-config");
  await mkdir(minioDataPath, { recursive: true });

  // 步骤 2：建立完全隔离的数据面，执行当前真实 migration，并配置独立的私有对象应用身份。
  await initializeMysql(mysqlIdentity, mysqlDataPath);
  mysqlProcess = startMysql(
    mysqlIdentity,
    mysqlDataPath,
    ports.mysql,
    sandboxPath,
  );
  await waitForMysql(mysqlProcess, ports.mysql);
  const databaseUrl = await createDatabase(ports.mysql);
  await runProcess(process.execPath, [resolve("dist/common/db/migrate.js")], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeoutMs: 120_000,
  });
  database = await connectDatabase(ports.mysql);
  const context = await seedRealInventoryContext(database);
  minioProcess = startMinio(inputs, secrets, ports, minioDataPath);
  await waitForMinio(minioProcess, ports.minio);
  await configureMinio(inputs, secrets, ports.minio, minioConfigurationPath);

  // 步骤 3：启动生产构建；Worker 必须先完成真实工具预检和注册，浏览器 API 才能创建任务。
  serverProcess = startProcess(process.execPath, [resolve("dist/main.js")], {
    cwd: process.cwd(),
    env: createServerEnvironment({
      databaseUrl,
      ports,
      secrets,
      context,
    }),
  });
  const health = await waitForRealServer(serverProcess, ports.api);
  const workerId = randomUUID();
  workerProcess = startProcess(
    process.execPath,
    [resolve("../dnf-patch-worker/dist/main.js")],
    {
      cwd: resolve("../dnf-patch-worker"),
      env: createWorkerEnvironment(inputs, secrets, ports, workerId),
    },
  );
  await waitForInventoryWorker(database, workerProcess, workerId);

  // 步骤 4：经正式 API 驱动完整链路，并在 Worker 完成后再次哈希官方源证明没有被修改。
  const scenario = await exerciseRealInventory({
    database,
    serverProcess,
    workerProcess,
    apiPort: ports.api,
    clientToken: secrets.clientToken,
    sourceBefore: inputs.sourceBefore,
    inspectCurrentSource: () => inspectSource(inputs.inventory.sourceNpkPath),
    sourceRoot: inputs.inventory.officialGameRoot,
    sourcePath: inputs.inventory.sourceNpkPath,
    storage: {
      endpoint: `http://127.0.0.1:${String(ports.minio)}`,
      bucket: secrets.bucket,
      accessKeyId: secrets.minioAppAccessKey,
      secretAccessKey: secrets.minioAppSecretKey,
    },
    workerId,
  });
  const frontendRoot = resolve("../dnf-patch");
  const apiBaseUrl = `http://127.0.0.1:${String(ports.api)}/v1`;
  await registerRealBrowserUser(apiBaseUrl, secrets);
  await buildRealBrowser(frontendRoot, apiBaseUrl);
  browserProcess = startRealBrowserPreview(frontendRoot, ports.browser);
  await waitForRealBrowserPreview(browserProcess, ports.browser);
  await runRealBrowserScenario({
    frontendRoot,
    browserPort: ports.browser,
    outputPath: join(sandboxPath, "browser-test-results"),
    secrets,
    sourceSha256: inputs.sourceBefore.sha256,
  });
  const browser = await inspectRealBrowserSession(
    database,
    secrets.browserUsername,
  );
  result = {
    schemaVersion: 1,
    kind: "dnf-patch-real-inventory-runtime-v1",
    status: "passed",
    mysql: {
      version: mysqlIdentity.version,
      executableSha256: mysqlIdentity.sha256,
      isolatedPort: ports.mysql,
      usedSystemPort3306: false,
    },
    minio: {
      executableSha256: inputs.minio.sha256,
      clientSha256: inputs.mc.sha256,
      isolatedPort: ports.minio,
      independentApplicationIdentity: true,
    },
    server: { healthStatus: health.status, database: health.database },
    browser: { ...browser, isolatedPort: ports.browser },
    ...scenario,
  };
} catch (error) {
  primaryError = error;
} finally {
  // 各资源逆依赖独立清理；任一项失败都会使最终门禁失败，但不会阻止后续清理继续执行。
  await cleanup("Browser preview", async () => {
    if (browserProcess) {
      await stopChild(browserProcess, "Real Browser Preview");
    }
  });
  await cleanup("Worker", async () => {
    if (workerProcess) await stopChild(workerProcess, "Real Inventory Worker");
  });
  await cleanup("Server", async () => {
    if (serverProcess) await stopChild(serverProcess, "Real Inventory Server");
  });
  await cleanup("database connection", async () => {
    if (database) await database.end();
  });
  await cleanup("isolated MySQL", async () => {
    if (mysqlProcess && mysqlIdentity && ports) {
      await stopMysql(mysqlProcess, mysqlIdentity, ports.mysql);
    }
  });
  await cleanup("isolated MinIO", async () => {
    if (minioProcess) await stopChild(minioProcess, "Isolated MinIO");
  });
  await cleanup("runtime sandbox", async () => {
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
  throw new Error(
    [
      ...(primaryError ? [errorMessage(primaryError)] : []),
      ...cleanupErrors,
    ].join("\n"),
  );
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

async function cleanup(label, action) {
  try {
    await action();
  } catch (error) {
    cleanupErrors.push(`Failed to clean up ${label}: ${errorMessage(error)}`);
  }
}
