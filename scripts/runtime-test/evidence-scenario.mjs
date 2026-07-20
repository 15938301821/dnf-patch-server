/**
 * @fileoverview 通过 REST 验证 Artifact/NPK producing Run 归属，不读取或保存官方资源正文。
 * @module runtime-test
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 3 evidence ownership
 */
import { requestJson } from "./api-support.mjs";
import { assert } from "./process.mjs";

/** 创建同 Run 的 Artifact 与 NPK inventory，并拒绝跨 Run Artifact 引用。 */
export async function exerciseEvidenceApi({
  baseUrl,
  clientToken,
  projectId,
  runId,
  otherRunId,
}) {
  const artifact = await requestJson(
    baseUrl,
    `/runs/${runId}/artifacts`,
    {
      method: "POST",
      clientToken,
      body: {
        logicalName: "Runtime inventory evidence",
        storageKey: "runtime/inventories/runtime-inventory.json",
        mediaType: "application/json",
        byteLength: 128,
        sha256: "B".repeat(64),
        provenance: { source: "runtime-test" },
      },
    },
    201,
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
