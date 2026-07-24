/**
 * @fileoverview 通过数据库前置 Artifact 和真实 REST 验证 NPK producing Run 归属，不读取或保存资源正文。
 * @module runtime-test
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 3 evidence ownership
 */
import { randomUUID } from "node:crypto";
import { requestJson } from "./api-support.mjs";
import { assert } from "./process.mjs";

/** 预置同 Run Artifact 元数据，再经只读 Artifact 与 NPK API 验证归属并拒绝跨 Run 引用。 */
export async function exerciseEvidenceApi({
  baseUrl,
  clientToken,
  database,
  projectId,
  runId,
  otherRunId,
}) {
  const artifactId = await insertArtifactFixture(database, runId);
  const artifacts = await requestJson(
    baseUrl,
    `/runs/${runId}/artifacts`,
    { clientToken },
    200,
  );
  const artifact = artifacts.find((candidate) => candidate.id === artifactId);
  assert(
    artifact?.runId === runId && artifact.sha256 === "B".repeat(64),
    "Run Artifact listing did not expose the bounded metadata fixture.",
  );
  const inventoryBody = {
    runId,
    sourceLabel: "Runtime read-only NPK inventory",
    sourceLength: 4_096,
    sourceSha256: "C".repeat(64),
    inventoryArtifactId: artifact.id,
    entries: [
      {
        internalPath: "Character\\Runtime.IMG",
        imgVersion: 2,
        frameCount: 3,
        metadataSha256: "D".repeat(64),
      },
    ],
  };
  const inventory = await requestJson(
    baseUrl,
    `/projects/${projectId}/npk-inventories`,
    { method: "POST", clientToken, body: inventoryBody },
    201,
  );
  assert(
    inventory.projectId === projectId &&
      inventory.runId === runId &&
      inventory.inventoryArtifactId === artifact.id &&
      inventory.entryCount === 1,
    "NPK inventory did not preserve its Project, Run, and Artifact ownership.",
  );
  const mismatch = await requestJson(
    baseUrl,
    `/projects/${projectId}/npk-inventories`,
    {
      method: "POST",
      clientToken,
      body: {
        ...inventoryBody,
        runId: otherRunId,
        sourceSha256: "E".repeat(64),
      },
    },
    409,
  );
  assert(
    mismatch.code === "INVENTORY_ARTIFACT_RUN_MISMATCH",
    "NPK inventory accepted an Artifact from another producing Run.",
  );
  return {
    artifactId: artifact.id,
    inventoryId: inventory.id,
    httpOwnershipEnforced: true,
  };
}

/**
 * 在隔离数据库中建立已知 Run 的 Artifact 元数据前置条件。
 * 该 fixture 不代表对象已上传或由对象存储复核，只为 NPK 归属 API 提供受外键约束的引用对象。
 */
async function insertArtifactFixture(database, runId) {
  const artifactId = randomUUID();
  await database.query(
    "INSERT INTO artifacts (id, run_id, logical_name, storage_key, media_type, byte_length, sha256, provenance, created_at) VALUES (?, ?, 'Runtime inventory evidence', ?, 'application/json', 128, ?, ?, CURRENT_TIMESTAMP(3))",
    [
      artifactId,
      runId,
      `artifacts/${artifactId}`,
      "B".repeat(64),
      JSON.stringify({ source: "runtime-test-fixture" }),
    ],
  );
  return artifactId;
}
