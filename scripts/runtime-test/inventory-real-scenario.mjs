/**
 * @fileoverview 通过正式 Resource Import API 驱动真实 Worker 扫描官方 NPK，并核对隔离 MySQL、
 * 私有 MinIO 对象与安全终态；不创建 Profession、最终主题包或部署结论。
 * @module scripts/runtime-test/inventory-real-scenario
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 用户直接要求整体真实数据测试
 *
 * 调用关系：test-inventory-real 在四个进程就绪后调用本模块；本模块先预置冻结资源上下文，随后
 * 使用普通 Client token 创建任务，等待 Worker 正式 claim/上传/finalize/complete，最后直接核对
 * 数据库和对象正文。副作用只发生在本次临时 MySQL 与 MinIO。
 * 安全边界：所有断言基于真实持久化证据；对象必须保持私有，正文不得含本机绝对路径；四项安全
 * 状态必须为 false。通过仅证明这一固定官方 NPK 的 Inventory 链，不证明技能映射或客户端兼容。
 */
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { sha256Json } from "../../dist/common/utils/canonical.js";
import { requestJson } from "./api-support.mjs";
import { assert, assertRunning, delay, processFailure } from "./process.mjs";

const host = "127.0.0.1";

/** 在隔离库预置 Resource Import 必需的 Factory v2、Project 与冻结 Snapshot。 */
export async function seedRealInventoryContext(database) {
  const projectId = randomUUID();
  const snapshotId = randomUUID();
  const factoryId = `inventory-e2e-${randomUUID()}`;
  const config = {
    schemaVersion: 2,
    profileId: "resource-profile",
    policyId: "inventory-real-policy",
    policySha256: "A".repeat(64),
    allowedJobKinds: ["inventory"],
    jobContracts: [{ kind: "inventory", schemaVersion: 1 }],
    arbitraryExecution: false,
    deploymentAuthorized: false,
  };
  await database.query(
    "INSERT INTO factories (id, version, display_name, config, config_sha256, enabled, created_at) VALUES (?, '2.0.0', 'Real Inventory E2E Factory', ?, ?, true, CURRENT_TIMESTAMP(3))",
    [factoryId, JSON.stringify(config), sha256Json(config)],
  );
  await database.query(
    "INSERT INTO projects (id, factory_id, client_project_id, display_name, canonical_name, version, archived, created_at, updated_at) VALUES (?, ?, 'real-inventory-e2e', 'Real Inventory E2E Project', ?, 1, false, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [projectId, factoryId, `real-inventory-${projectId}`],
  );
  await database.query(
    "INSERT INTO project_snapshots (id, project_id, client_snapshot_id, root_rules_sha256, manifest_sha256, prompt_tree_sha256, tool_catalog_sha256, repository_revision, full_skill_coverage_proven, created_at) VALUES (?, ?, 'real-inventory-snapshot', ?, ?, ?, ?, 'real-inventory-e2e', false, CURRENT_TIMESTAMP(3))",
    [
      snapshotId,
      projectId,
      "1".repeat(64),
      "2".repeat(64),
      "3".repeat(64),
      "4".repeat(64),
    ],
  );
  return { factoryId, projectId, snapshotId };
}

/** 等待真实 Server 达到数据库 available；degraded 不能作为该门禁成功。 */
export async function waitForRealServer(processHandle, apiPort) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    assertRunning(processHandle, "Real Inventory Server");
    try {
      const response = await fetch(
        `http://${host}:${String(apiPort)}/v1/health`,
        { signal: AbortSignal.timeout(1_500) },
      );
      if (response.ok) {
        const health = await response.json();
        assert(
          health.status === "ok" && health.database === "available",
          "Real Inventory Server health is not backed by MySQL.",
        );
        return health;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("not backed")) {
        throw error;
      }
    }
    await delay(100);
  }
  throw processFailure(processHandle, "Real Inventory Server did not start.");
}

/** 等待 Worker 完成真实本机预检并以唯一 `inventory` capability 注册。 */
export async function waitForInventoryWorker(
  database,
  workerProcess,
  workerId,
) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    assertRunning(workerProcess, "Real Inventory Worker");
    const [rows] = await database.query(
      "SELECT capabilities, disabled FROM workers WHERE id = ?",
      [workerId],
    );
    if (rows.length === 1) {
      const capabilities = normalizeJson(rows[0].capabilities);
      assert(!rows[0].disabled, "Real Inventory Worker registered disabled.");
      assert(
        Array.isArray(capabilities) &&
          capabilities.length === 1 &&
          capabilities[0] === "inventory",
        "Real Inventory Worker registered unexpected capabilities.",
      );
      return;
    }
    await delay(100);
  }
  throw processFailure(
    workerProcess,
    "Real Inventory Worker did not register after local preflight.",
  );
}

/**
 * 创建正式 Resource Import Job，等待真实 Worker 完成，并核对数据库、对象与来源只读证据。
 * @returns 不含 token、对象 key、路径或正文的脱敏证明摘要。
 */
export async function exerciseRealInventory({
  database,
  serverProcess,
  workerProcess,
  apiPort,
  clientToken,
  sourceBefore,
  inspectCurrentSource,
  sourceRoot,
  sourcePath,
  storage,
  workerId,
}) {
  const baseUrl = `http://${host}:${String(apiPort)}/v1`;
  const before = await requestJson(
    baseUrl,
    "/resource-imports/overview",
    { clientToken },
    200,
  );
  assert(
    before.data.status === "idle" && before.data.resourceRootConfigured,
    "Resource Import was not ready after Worker registration.",
  );
  const created = await requestJson(
    baseUrl,
    "/resource-imports/jobs",
    { method: "POST", clientToken, body: {} },
    201,
  );
  assert(created.data.status === "queued", "Resource Import did not queue.");
  const terminal = await waitForTerminalJob({
    database,
    serverProcess,
    workerProcess,
    jobId: created.data.id,
  });
  assert(
    terminal.jobStatus === "passed" && terminal.runStatus === "passed",
    `Real Inventory ended as ${terminal.jobStatus}/${terminal.runStatus}.`,
  );
  const evidence = await inspectPersistedEvidence(database, terminal, workerId);
  const objects = await inspectObjects(storage, evidence.artifacts, {
    sourceRoot,
    sourcePath,
    expectedSourceSha256: sourceBefore.sha256,
    expectedEntryCount: evidence.inventory.entryCount,
  });
  const after = await requestJson(
    baseUrl,
    "/resource-imports/overview",
    { clientToken },
    200,
  );
  assert(
    after.data.status === "idle" &&
      after.data.resourceVersion === sourceBefore.sha256 &&
      after.data.lastJobId === created.data.id,
    "Resource Import overview did not expose the frozen current Run evidence.",
  );
  const sourceAfter = await inspectCurrentSource();
  assert(
    sourceBefore.byteLength === sourceAfter.byteLength &&
      sourceBefore.sha256 === sourceAfter.sha256,
    "Official source NPK changed during the real scan.",
  );
  return {
    worker: { capability: "inventory", attempt: terminal.attemptCount },
    job: { status: terminal.jobStatus, runStatus: terminal.runStatus },
    source: {
      byteLength: sourceAfter.byteLength,
      sha256: sourceAfter.sha256,
      unchanged: true,
    },
    inventory: {
      status: evidence.inventory.status,
      entryCount: evidence.inventory.entryCount,
      artifactCount: evidence.artifacts.length,
      finalizedUploadCount: evidence.uploads.length,
    },
    objectStorage: objects,
    safety: evidence.safety,
  };
}

async function waitForTerminalJob({
  database,
  serverProcess,
  workerProcess,
  jobId,
}) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    assertRunning(serverProcess, "Real Inventory Server");
    assertRunning(workerProcess, "Real Inventory Worker");
    const [rows] = await database.query(
      "SELECT jobs.id AS jobId, jobs.run_id AS runId, jobs.status AS jobStatus, jobs.attempt_count AS attemptCount, runs.status AS runStatus FROM jobs INNER JOIN runs ON runs.id = jobs.run_id WHERE jobs.id = ?",
      [jobId],
    );
    const row = rows[0];
    if (row && ["passed", "failed", "blocked"].includes(row.jobStatus)) {
      if (row.jobStatus !== "passed") {
        const [attempts] = await database.query(
          "SELECT status, error_code AS errorCode FROM job_attempts WHERE job_id = ? ORDER BY attempt DESC LIMIT 1",
          [jobId],
        );
        const attempt = attempts[0];
        throw new Error(
          `Real Inventory Job failed: ${attempt?.status ?? row.jobStatus}/${attempt?.errorCode ?? "NO_ERROR_CODE"}.`,
        );
      }
      return row;
    }
    await delay(250);
  }
  throw new Error("Real Inventory Job did not finish within 10 minutes.");
}

async function inspectPersistedEvidence(database, terminal, workerId) {
  const [attempts] = await database.query(
    "SELECT worker_id AS workerId, attempt, status, result_sha256 AS resultSha256, finished_at AS finishedAt FROM job_attempts WHERE job_id = ?",
    [terminal.jobId],
  );
  const [inventories] = await database.query(
    "SELECT id, source_length AS sourceLength, source_sha256 AS sourceSha256, entry_count AS entryCount, inventory_artifact_id AS inventoryArtifactId, source_frame_manifest_artifact_id AS manifestArtifactId, status FROM npk_inventories WHERE run_id = ?",
    [terminal.runId],
  );
  const inventory = inventories[0];
  assert(inventories.length === 1, "Expected one frozen Inventory.");
  const [entries] = await database.query(
    "SELECT internal_path AS internalPath, img_version AS imgVersion, frame_count AS frameCount, metadata_sha256 AS metadataSha256 FROM npk_inventory_entries WHERE inventory_id = ? ORDER BY internal_path",
    [inventory.id],
  );
  const [artifacts] = await database.query(
    "SELECT id, logical_name AS logicalName, storage_key AS storageKey, media_type AS mediaType, byte_length AS byteLength, sha256 FROM artifacts WHERE run_id = ? ORDER BY logical_name",
    [terminal.runId],
  );
  const [uploads] = await database.query(
    "SELECT artifact_id AS artifactId, attempt, status, finalized_at AS finalizedAt FROM artifact_upload_sessions WHERE run_id = ? ORDER BY logical_name",
    [terminal.runId],
  );
  const [runRows] = await database.query(
    "SELECT deployment_authorized AS deploymentAuthorized, deployment_performed AS deploymentPerformed, full_skill_coverage_proven AS fullSkillCoverageProven, client_compatibility_proven AS clientCompatibilityProven FROM runs WHERE id = ?",
    [terminal.runId],
  );
  const attempt = attempts[0];
  assert(
    attempts.length === 1 &&
      attempt.workerId === workerId &&
      attempt.attempt === 1 &&
      attempt.status === "passed" &&
      attempt.finishedAt !== null,
    "Job attempt did not preserve the real Worker completion evidence.",
  );
  assert(
    inventory.status === "frozen" &&
      Number(inventory.entryCount) > 0 &&
      entries.length === Number(inventory.entryCount),
    "Inventory or its real IMG entries were not frozen consistently.",
  );
  assert(
    artifacts.length === 2 &&
      artifacts.map((row) => row.logicalName).join(",") ===
        "inventory-evidence.json,source-frame-manifest.json" &&
      artifacts.every(
        (row) => row.mediaType === "application/json" && row.byteLength > 0,
      ),
    "Expected two non-empty JSON Artifacts.",
  );
  assert(
    uploads.length === 2 &&
      uploads.every(
        (row) =>
          row.status === "finalized" &&
          row.attempt === 1 &&
          row.finalizedAt !== null,
      ),
    "Artifact uploads were not finalized under attempt 1.",
  );
  const inventoryArtifact = artifacts.find(
    (artifact) => artifact.id === inventory.inventoryArtifactId,
  );
  assert(
    inventoryArtifact && attempt.resultSha256 === inventoryArtifact.sha256,
    "Job result digest does not identify the finalized Inventory Artifact.",
  );
  assert(
    artifacts.some((artifact) => artifact.id === inventory.manifestArtifactId),
    "Frozen Inventory does not reference its manifest Artifact.",
  );
  assert(
    entries.every(
      (entry) =>
        isSafeInternalPath(entry.internalPath) &&
        Number.isInteger(entry.imgVersion) &&
        entry.imgVersion >= 1 &&
        entry.imgVersion <= 6 &&
        Number.isInteger(entry.frameCount) &&
        entry.frameCount >= 0 &&
        entry.frameCount <= 1_000_000 &&
        /^[A-F0-9]{64}$/u.test(entry.metadataSha256),
    ),
    "Inventory entries contain invalid path, frame, version, or digest data.",
  );
  const safety = runRows[0];
  assert(
    safety &&
      !safety.deploymentAuthorized &&
      !safety.deploymentPerformed &&
      !safety.fullSkillCoverageProven &&
      !safety.clientCompatibilityProven,
    "Real Inventory elevated an immutable safety state.",
  );
  return { inventory, entries, artifacts, uploads, safety };
}

async function inspectObjects(storage, artifacts, expectations) {
  const client = new S3Client({
    endpoint: storage.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: storage.accessKeyId,
      secretAccessKey: storage.secretAccessKey,
    },
  });
  const listed = await client.send(
    new ListObjectsV2Command({ Bucket: storage.bucket }),
  );
  assert(
    listed.KeyCount === 2 && listed.Contents?.length === 2,
    "Private bucket does not contain exactly two finalized objects.",
  );
  for (const artifact of artifacts) {
    const anonymous = await fetch(
      `${storage.endpoint}/${storage.bucket}/${artifact.storageKey
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
      { signal: AbortSignal.timeout(3_000) },
    );
    anonymous.body?.cancel();
    assert(
      anonymous.status === 403,
      "Artifact object was anonymously readable.",
    );
    const output = await client.send(
      new GetObjectCommand({
        Bucket: storage.bucket,
        Key: artifact.storageKey,
      }),
    );
    const bytes = await collectBody(output.Body, 16 * 1024 * 1024);
    assert(
      bytes.byteLength === Number(artifact.byteLength) &&
        createHash("sha256").update(bytes).digest("hex").toUpperCase() ===
          artifact.sha256 &&
        output.ContentType === artifact.mediaType,
      "MinIO object bytes do not match finalized Artifact metadata.",
    );
    const text = Buffer.from(bytes).toString("utf8");
    assert(
      !text.toLowerCase().includes(expectations.sourceRoot.toLowerCase()) &&
        !text.toLowerCase().includes(expectations.sourcePath.toLowerCase()),
      "Artifact leaked a local absolute source path.",
    );
    const document = JSON.parse(text);
    assertNoAbsolutePaths(document);
    assert(
      document.source?.sha256 === expectations.expectedSourceSha256 &&
        document.safety?.deploymentAuthorized === false &&
        document.safety?.deploymentPerformed === false &&
        document.safety?.fullSkillCoverageProven === false &&
        document.safety?.clientCompatibilityProven === false &&
        document.entries?.length === expectations.expectedEntryCount,
      "Artifact body does not preserve source, safety, or entry evidence.",
    );
  }
  return {
    privateBucket: true,
    applicationReadVerified: true,
    objectCount: 2,
    byteAndHashVerified: true,
  };
}

async function collectBody(body, maximumBytes) {
  assert(
    body && typeof body[Symbol.asyncIterator] === "function",
    "Missing S3 body.",
  );
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    assert(total <= maximumBytes, "Artifact body exceeded the runtime budget.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function assertNoAbsolutePaths(value) {
  if (typeof value === "string") {
    assert(
      !/^[A-Za-z]:[\\/]/u.test(value) && !/^\\\\/u.test(value),
      "Artifact JSON contains a Windows absolute path.",
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertNoAbsolutePaths);
    return;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach(assertNoAbsolutePaths);
  }
}

function isSafeInternalPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[A-Za-z]:/u.test(value) &&
    !value.split(/[\\/]/u).some((segment) => segment === "..")
  );
}

function normalizeJson(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}
