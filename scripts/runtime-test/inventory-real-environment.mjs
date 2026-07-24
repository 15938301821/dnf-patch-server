/**
 * @fileoverview 为真实 Inventory 门禁校验固定本机工具，并管理一次性 MinIO 与两端进程环境；
 * 不读取业务 `.env`、系统 MySQL 数据库或官方 NPK 正文，也不向输出暴露临时凭据。
 * @module scripts/runtime-test/inventory-real-environment
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 用户直接要求整体真实数据测试
 *
 * 调用关系：test-inventory-real 在启动隔离基础设施前调用本模块；本模块复用 Worker 生产环境
 * parser 与 runtime process helper，随后启动/配置回环 MinIO，并构造 Server、Worker 子进程环境。
 * 输入输出：输入是显式进程变量中的固定路径和 SHA-256；输出是已验证身份、随机临时秘密及
 * 子进程环境。副作用限于读取/哈希固定文件、启动 MinIO、在临时配置目录创建私有 bucket/用户。
 * 安全边界：秘密仅在内存和短命子进程环境中存在；应用身份必须独立于 MinIO root；Worker 只
 * 获得 Inventory 配置，不能因父进程残留变量意外注册 Profession 或接收任意执行参数。
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseWorkerEnvironment } from "../../../dnf-patch-worker/dist/config/environment.js";
import {
  assert,
  assertRunning,
  delay,
  findFreePort,
  processFailure,
  runProcess,
  startProcess,
} from "./process.mjs";

const host = "127.0.0.1";
const workerVariableNames = [
  "DNF_PATCH_OFFICIAL_GAME_ROOT",
  "DNF_PATCH_INVENTORY_SOURCE_RELATIVE_PATH",
  "DNF_PATCH_INVENTORY_SOURCE_SHA256",
  "DNF_PATCH_INVENTORY_PROFILE_ID",
  "DNF_PATCH_INVENTORY_TOOL_PATH",
  "DNF_PATCH_INVENTORY_TOOL_SHA256",
  "DNF_PATCH_INVENTORY_EXTRACTOR_DIRECTORY",
  "DNF_PATCH_INVENTORY_EXTRACTOR_CORE_SHA256",
  "DNF_PATCH_INVENTORY_EXTRACTOR_JSON_SHA256",
  "DNF_PATCH_INVENTORY_EXTRACTOR_ZLIB_SHA256",
  "DNF_PATCH_POWERSHELL_PATH",
];

/**
 * 解析并复核真实门禁的所有显式本机输入。
 * @returns 固定 MinIO/MC 身份、只含 Inventory 的 Worker 配置及执行前官方源摘要。
 * @throws 配置缺失、路径身份不符或任一固定 SHA-256 漂移时阻断，禁止启动基础设施。
 */
export async function resolveRealInventoryInputs() {
  const minioPath = await resolveExecutable(
    "REAL_INVENTORY_MINIO_PATH",
    "minio.exe",
  );
  const mcPath = await resolveExecutable("REAL_INVENTORY_MC_PATH", "mc.exe");
  const supplied = Object.fromEntries(
    workerVariableNames.map((name) => [name, requiredEnvironment(name)]),
  );
  const parsed = parseWorkerEnvironment({
    DNF_PATCH_SERVER_URL: "http://127.0.0.1:56789/v1",
    DNF_PATCH_WORKER_TOKEN: "x".repeat(32),
    DNF_PATCH_WORKER_ID: "11111111-1111-4111-8111-111111111111",
    DNF_PATCH_WORKER_NAME: "Real Inventory Validation Worker",
    ...supplied,
  });
  assert(parsed.inventory, "Inventory environment did not parse.");
  const inventory = parsed.inventory;
  const identities = await Promise.all([
    verifyHash("source NPK", inventory.sourceNpkPath, inventory.sourceSha256),
    verifyHash("inventory tool", inventory.toolPath, inventory.toolSha256),
    verifyHash(
      "ExtractorSharp.Core",
      join(inventory.extractorDirectory, "ExtractorSharp.Core.dll"),
      inventory.extractorCoreSha256,
    ),
    verifyHash(
      "ExtractorSharp.Json",
      join(inventory.extractorDirectory, "ExtractorSharp.Json.dll"),
      inventory.extractorJsonSha256,
    ),
    verifyHash(
      "ExtractorSharp zlib",
      join(inventory.extractorDirectory, "zlib1.dll"),
      inventory.extractorZlibSha256,
    ),
  ]);
  return {
    minio: { path: minioPath, sha256: await sha256File(minioPath) },
    mc: { path: mcPath, sha256: await sha256File(mcPath) },
    inventory,
    workerVariables: supplied,
    sourceBefore: identities[0],
  };
}

/** 为 MySQL、API、MinIO API 与 Console 分配互不相同的临时回环端口。 */
export async function allocateRuntimePorts() {
  const ports = new Set();
  while (ports.size < 5) ports.add(await findFreePort());
  const [mysql, api, minio, minioConsole, browser] = ports;
  return { mysql, api, minio, minioConsole, browser };
}

/** 生成仅用于本次隔离运行的相互独立秘密；调用方不得记录返回值。 */
export function createRuntimeSecrets() {
  return {
    clientToken: randomBytes(32).toString("hex"),
    workerToken: randomBytes(32).toString("hex"),
    browserSessionSecret: randomBytes(32).toString("hex"),
    browserRegistrationToken: randomBytes(32).toString("hex"),
    browserUsername: `real-${randomBytes(8).toString("hex")}`,
    browserPassword: randomBytes(24).toString("base64url"),
    browserDisplayName: "Real Browser E2E User",
    modelMasterKey: randomBytes(32).toString("base64url"),
    minioRootUser: `root-${randomBytes(8).toString("hex")}`,
    minioRootPassword: `root-secret-${randomBytes(32).toString("hex")}`,
    minioAppAccessKey: `app-${randomBytes(8).toString("hex")}`,
    minioAppSecretKey: `app-secret-${randomBytes(32).toString("hex")}`,
    bucket: `dnf-patch-e2e-${randomBytes(8).toString("hex")}`,
  };
}

/** 启动只绑定随机回环端口、数据目录位于本次 sandbox 的 MinIO。 */
export function startMinio(inputs, secrets, ports, dataPath) {
  return startProcess(
    inputs.minio.path,
    [
      "--quiet",
      "--anonymous",
      "server",
      "--address",
      `${host}:${String(ports.minio)}`,
      "--console-address",
      `${host}:${String(ports.minioConsole)}`,
      dataPath,
    ],
    {
      env: {
        ...process.env,
        MINIO_ROOT_USER: secrets.minioRootUser,
        MINIO_ROOT_PASSWORD: secrets.minioRootPassword,
      },
    },
  );
}

/** 等待 MinIO live probe，并拒绝把提前退出或超时当成可用。 */
export async function waitForMinio(processHandle, port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    assertRunning(processHandle, "Isolated MinIO");
    try {
      const response = await fetch(
        `http://${host}:${String(port)}/minio/health/live`,
        { signal: AbortSignal.timeout(1_500) },
      );
      if (response.ok) return;
    } catch {
      // 启动窗口内连接拒绝是预期重试条件；截止或进程退出仍会失败。
    }
    await delay(100);
  }
  throw processFailure(processHandle, "Isolated MinIO did not become ready.");
}

/**
 * 使用临时 root 配置私有 bucket 与最小应用用户，并以应用身份实际列举 bucket。
 * MC 配置和 policy 文件都位于 sandbox；任何命令失败时上层 finally 会删除整个目录。
 */
export async function configureMinio(inputs, secrets, port, configurationPath) {
  await mkdir(configurationPath, { recursive: true });
  const endpoint = `http://${host}:${String(port)}`;
  const policyName = "dnf-patch-e2e-artifacts";
  const policyPath = join(configurationPath, "application-policy.json");
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "s3:GetBucketLocation",
          "s3:ListBucket",
          "s3:ListBucketMultipartUploads",
        ],
        Resource: [`arn:aws:s3:::${secrets.bucket}`],
      },
      {
        Effect: "Allow",
        Action: [
          "s3:AbortMultipartUpload",
          "s3:DeleteObject",
          "s3:GetObject",
          "s3:ListMultipartUploadParts",
          "s3:PutObject",
        ],
        Resource: [`arn:aws:s3:::${secrets.bucket}/*`],
      },
    ],
  };
  await writeFile(policyPath, JSON.stringify(policy), "utf8");
  const prefix = ["--config-dir", configurationPath];
  const commands = [
    [
      ...prefix,
      "alias",
      "set",
      "bootstrap",
      endpoint,
      secrets.minioRootUser,
      secrets.minioRootPassword,
      "--api",
      "S3v4",
    ],
    [...prefix, "mb", "--ignore-existing", `bootstrap/${secrets.bucket}`],
    [...prefix, "anonymous", "set", "none", `bootstrap/${secrets.bucket}`],
    [
      ...prefix,
      "admin",
      "policy",
      "create",
      "bootstrap",
      policyName,
      policyPath,
    ],
    [
      ...prefix,
      "admin",
      "user",
      "add",
      "bootstrap",
      secrets.minioAppAccessKey,
      secrets.minioAppSecretKey,
    ],
    [
      ...prefix,
      "admin",
      "policy",
      "attach",
      "bootstrap",
      policyName,
      "--user",
      secrets.minioAppAccessKey,
    ],
    [
      ...prefix,
      "alias",
      "set",
      "application",
      endpoint,
      secrets.minioAppAccessKey,
      secrets.minioAppSecretKey,
      "--api",
      "S3v4",
    ],
    [...prefix, "ls", `application/${secrets.bucket}`],
  ];
  for (const [index, args] of commands.entries()) {
    try {
      await runProcess(inputs.mc.path, args, { timeoutMs: 30_000 });
    } catch {
      // mc 可能把位置参数回显到 stderr；这里不得让一次性 root/application secret 进入门禁输出。
      throw new Error(`MINIO_CONFIGURATION_STEP_${String(index + 1)}_FAILED`);
    }
  }
}

/** 构造生产 Server 子进程环境；真实外部模型不会在 Inventory 流程中调用。 */
export function createServerEnvironment({
  databaseUrl,
  ports,
  secrets,
  context,
}) {
  return {
    ...process.env,
    NODE_ENV: "test",
    HOST: host,
    PORT: String(ports.api),
    CORS_ORIGINS: `http://${host}:${String(ports.browser)}`,
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_SIZE: "3",
    DNF_REPOSITORY_ROOT: resolve("../dnf-patch"),
    CLIENT_SHARED_TOKEN: secrets.clientToken,
    WORKER_SHARED_TOKEN: secrets.workerToken,
    BROWSER_SESSION_SECRET: secrets.browserSessionSecret,
    USER_REGISTRATION_TOKEN: secrets.browserRegistrationToken,
    MODEL_CREDENTIAL_MASTER_KEY: secrets.modelMasterKey,
    MODEL_CREDENTIAL_KEY_VERSION: "e2e-v1",
    OPENAI_BASE_URL: "https://kldai.cc/v1",
    OBJECT_STORAGE_ENABLED: "true",
    OBJECT_STORAGE_ENDPOINT: `http://${host}:${String(ports.minio)}`,
    OBJECT_STORAGE_REGION: "us-east-1",
    OBJECT_STORAGE_BUCKET: secrets.bucket,
    OBJECT_STORAGE_ACCESS_KEY: secrets.minioAppAccessKey,
    OBJECT_STORAGE_SECRET_KEY: secrets.minioAppSecretKey,
    OBJECT_STORAGE_FORCE_PATH_STYLE: "true",
    OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS: "300",
    RESOURCE_IMPORT_SERVER_MIRROR_ENABLED: "true",
    RESOURCE_IMPORT_PROJECT_ID: context.projectId,
    RESOURCE_IMPORT_SNAPSHOT_ID: context.snapshotId,
    OUTBOX_DISPATCH_INTERVAL_MS: "100",
    WORKER_LEASE_SECONDS: "300",
    WORKER_REAPER_INTERVAL_MS: "60000",
  };
}

/** 构造只注册 Inventory Handler 的 Worker 子进程环境，主动移除父进程 Profession 残留。 */
export function createWorkerEnvironment(inputs, secrets, ports, workerId) {
  const environment = {
    ...process.env,
    ...inputs.workerVariables,
    DNF_PATCH_SERVER_URL: `http://${host}:${String(ports.api)}/v1`,
    DNF_PATCH_WORKER_TOKEN: secrets.workerToken,
    DNF_PATCH_WORKER_ID: workerId,
    DNF_PATCH_WORKER_NAME: "Real Inventory Validation Worker",
    DNF_PATCH_REQUEST_TIMEOUT_MS: "30000",
    DNF_PATCH_WORKER_HEARTBEAT_MS: "5000",
    DNF_PATCH_JOB_HEARTBEAT_MS: "5000",
    DNF_PATCH_CLAIM_INTERVAL_MS: "250",
    DNF_PATCH_INVENTORY_TOOL_TIMEOUT_MS: "600000",
  };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("DNF_PATCH_PROFESSION_")) delete environment[name];
  }
  delete environment.DNF_PATCH_INVENTORY_SOURCE_NPK;
  return environment;
}

/** 再次计算官方源摘要，供场景结束后证明只读扫描未改变文件。 */
export async function inspectSource(path) {
  const file = await stat(path);
  assert(file.isFile(), "Official source is no longer a regular file.");
  return { byteLength: file.size, sha256: await sha256File(path) };
}

async function resolveExecutable(variableName, expectedName) {
  const configured = requiredEnvironment(variableName);
  const path = await realpath(configured);
  const file = await stat(path);
  assert(
    file.isFile() && basename(path).toLowerCase() === expectedName,
    `${variableName} has an unexpected executable identity.`,
  );
  return path;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert(value && value.trim().length > 0, `${name} is required.`);
  return value;
}

async function verifyHash(label, path, expectedSha256) {
  const file = await stat(path);
  assert(file.isFile(), `${label} is not a regular file.`);
  const actual = await sha256File(path);
  assert(actual === expectedSha256.toUpperCase(), `${label} SHA-256 drifted.`);
  return { byteLength: file.size, sha256: actual };
}

function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", rejectHash);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex").toUpperCase()));
  });
}
