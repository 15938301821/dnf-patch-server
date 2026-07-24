/**
 * @fileoverview 为隔离 MySQL 的 Profession 单技能接收场景建立并清理受外键约束的当前 attempt 证据。
 * @module scripts/runtime-test/profession-skill-production-fixture
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：profession-skill-production-scenario 在真实 Worker HTTP 请求前调用本模块；输入是已存在的
 * Project/Snapshot/source Run/Worker，输出是当前 lease、passed DTO 与预期证据 ID。
 * 安全边界：SQL 只写临时 MySQL；Artifact 行是元数据 fixture，不证明对象上传、真实模型、Aseprite、
 * NPK、客户端兼容或部署。所有 ID/JSON 都由脚本生成，绝不接收 HTTP 内容或本机路径。
 */
import {
  createProfessionSkillProductionData,
  professionSkillProductionHashes as hashes,
} from "./profession-skill-production-data.mjs";

/** 建立完整接收事实；任一插入失败时由上层销毁整个临时数据库，不做猜测性补偿。 */
export async function createProfessionSkillProductionFixture(
  database,
  { projectId, snapshotId, sourceRunId, workerId },
) {
  const fixture = createProfessionSkillProductionData(sourceRunId, workerId);
  const { ids, payload, payloadSha256, sourceProvenance, projectsProvenance } =
    fixture;

  await insertCatalogAndSource(database, {
    ids,
    projectId,
    sourceRunId,
    sourceProvenance,
  });
  await insertRunAndLease(database, {
    ids,
    projectId,
    snapshotId,
    workerId,
    payload,
    payloadSha256,
  });
  await insertProductionAndModelEvidence(database, {
    ids,
    workerId,
    promptSha256: payload.parameters.promptPackage.skills[0].promptSha256,
    sourceRunId,
  });
  await insertOutputUploads(database, {
    ids,
    workerId,
    projectsProvenance,
  });

  return fixture;
}

/** 将 validation upload 与 Artifact 从错误 projects 角色切换为唯一正确的 validation provenance。 */
export async function repairValidationProvenance(database, fixture) {
  const provenance = JSON.stringify(fixture.validationProvenance);
  await database.query(
    "UPDATE artifact_upload_sessions SET provenance = ? WHERE id = ?",
    [provenance, fixture.ids.validationUploadId],
  );
  await database.query("UPDATE artifacts SET provenance = ? WHERE id = ?", [
    provenance,
    fixture.ids.validationArtifactId,
  ]);
}

/** 逆依赖删除成功场景的全部专用行，使既有 runtime 精确行数断言保持独立。 */
export async function removeProfessionSkillProductionFixture(
  database,
  fixture,
) {
  const { ids } = fixture;
  await database.query(
    "DELETE FROM profession_skill_model_executions WHERE job_id = ?",
    [ids.jobId],
  );
  await database.query("DELETE FROM style_skill_productions WHERE id = ?", [
    ids.productionId,
  ]);
  await database.query("DELETE FROM style_packages WHERE id = ?", [
    ids.packageId,
  ]);
  await database.query(
    "DELETE FROM artifact_upload_sessions WHERE job_id = ?",
    [ids.jobId],
  );
  await database.query("DELETE FROM image_attempts WHERE id = ?", [
    ids.imageAttemptId,
  ]);
  await database.query("DELETE FROM model_calls WHERE id IN (?, ?)", [
    ids.engineerModelCallId,
    ids.artistModelCallId,
  ]);
  await database.query("DELETE FROM artifacts WHERE id IN (?, ?, ?, ?)", [
    ids.engineerArtifactId,
    ids.referenceArtifactId,
    ids.projectsArtifactId,
    ids.validationArtifactId,
  ]);
  await database.query("DELETE FROM job_attempts WHERE job_id = ?", [
    ids.jobId,
  ]);
  await database.query("DELETE FROM jobs WHERE id = ?", [ids.jobId]);
  await database.query("DELETE FROM run_events WHERE run_id = ?", [ids.runId]);
  await database.query(
    "DELETE FROM outbox_events WHERE aggregate_id = ? AND topic = 'run.event'",
    [ids.runId],
  );
  await database.query("DELETE FROM runs WHERE id = ?", [ids.runId]);
  await database.query("DELETE FROM npk_inventories WHERE id = ?", [
    ids.sourceInventoryId,
  ]);
  await database.query("DELETE FROM artifacts WHERE id = ?", [
    ids.sourceManifestArtifactId,
  ]);
  await database.query(
    "DELETE FROM profession_style_skills WHERE style_id = ? AND skill_id = ?",
    [ids.styleId, ids.skillId],
  );
  await database.query("DELETE FROM profession_styles WHERE id = ?", [
    ids.styleId,
  ]);
  await database.query("DELETE FROM profession_skills WHERE id = ?", [
    ids.skillId,
  ]);
  await database.query("DELETE FROM professions WHERE id = ?", [
    ids.professionId,
  ]);
}

async function insertCatalogAndSource(
  database,
  { ids, projectId, sourceRunId, sourceProvenance },
) {
  await database.query(
    "INSERT INTO artifacts (id, run_id, logical_name, storage_key, media_type, byte_length, sha256, provenance, created_at) VALUES (?, ?, 'source-frame-manifest.json', ?, 'application/json', 128, ?, ?, CURRENT_TIMESTAMP(3))",
    [
      ids.sourceManifestArtifactId,
      sourceRunId,
      `artifacts/${ids.sourceManifestArtifactId}`,
      hashes.manifest,
      JSON.stringify(sourceProvenance),
    ],
  );
  await database.query(
    "INSERT INTO npk_inventories (id, project_id, run_id, source_label, source_length, source_sha256, entry_count, status, source_frame_manifest_artifact_id, created_at) VALUES (?, ?, ?, 'Profession runtime source', 4096, ?, 1, 'frozen', ?, CURRENT_TIMESTAMP(3))",
    [
      ids.sourceInventoryId,
      projectId,
      sourceRunId,
      hashes.source,
      ids.sourceManifestArtifactId,
    ],
  );
  await database.query(
    "INSERT INTO professions (id, name, slug, canonical_name, publish_status, created_at, updated_at) VALUES (?, 'Runtime Profession', ?, ?, 'private', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [ids.professionId, ids.professionId, ids.professionId],
  );
  await database.query(
    "INSERT INTO profession_skills (id, profession_id, stable_key, display_name, prompt_status, mapping_status, execution_status, created_at, updated_at) VALUES (?, ?, 'runtime-skill', 'Runtime Skill', 'reviewed', 'unverified', 'draft-only', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [ids.skillId, ids.professionId],
  );
  await database.query(
    "INSERT INTO profession_styles (id, profession_id, name, canonical_name, description, agent, prompt, publish_status, created_at, updated_at) VALUES (?, ?, 'Runtime Style', ?, 'Runtime only', 'runtime', 'runtime', 'private', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [ids.styleId, ids.professionId, ids.styleId],
  );
  await database.query(
    "INSERT INTO profession_style_skills (profession_id, style_id, skill_id, ordinal, created_at, updated_at) VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [ids.professionId, ids.styleId, ids.skillId],
  );
}

async function insertRunAndLease(
  database,
  { ids, projectId, snapshotId, workerId, payload, payloadSha256 },
) {
  await database.query(
    "INSERT INTO runs (id, project_id, snapshot_id, client_run_id, idempotency_key, action, status, current_stage, request_sha256, request_fingerprint_sha256, server_connection_enabled, model_egress_authorized, deployment_authorized, deployment_performed, full_skill_coverage_proven, client_compatibility_proven, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'validate-only', 'running', 'profession', ?, ?, true, true, false, false, false, false, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [
      ids.runId,
      projectId,
      snapshotId,
      ids.runId,
      ids.jobId,
      "5".repeat(64),
      "6".repeat(64),
    ],
  );
  await database.query(
    "INSERT INTO style_packages (id, profession_id, style_id, run_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [ids.packageId, ids.professionId, ids.styleId, ids.runId],
  );
  await database.query(
    "INSERT INTO jobs (id, run_id, kind, status, payload, payload_sha256, lease_owner_id, lease_id, lease_expires_at, dispatch_ready_at, attempt_count, max_attempts, created_at, updated_at) VALUES (?, ?, 'profession', 'leased', ?, ?, ?, ?, CURRENT_TIMESTAMP(3) + INTERVAL 5 MINUTE, CURRENT_TIMESTAMP(3), 2, 3, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [
      ids.jobId,
      ids.runId,
      JSON.stringify(payload),
      payloadSha256,
      workerId,
      ids.leaseId,
    ],
  );
  await database.query(
    "INSERT INTO job_attempts (id, job_id, worker_id, lease_id, attempt, status, started_at) VALUES (?, ?, ?, ?, 2, 'running', CURRENT_TIMESTAMP(3))",
    [ids.attemptId, ids.jobId, workerId, ids.leaseId],
  );
}

async function insertProductionAndModelEvidence(
  database,
  { ids, workerId, promptSha256, sourceRunId },
) {
  await database.query(
    "INSERT INTO style_skill_productions (id, profession_id, style_id, skill_id, run_id, source_run_id, source_frame_manifest_artifact_id, prompt_sha256, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'validating', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [
      ids.productionId,
      ids.professionId,
      ids.styleId,
      ids.skillId,
      ids.runId,
      sourceRunId,
      ids.sourceManifestArtifactId,
      promptSha256,
    ],
  );
  await insertArtifact(database, ids.runId, ids.engineerArtifactId, {
    logicalName: "engineer-plan.json",
    mediaType: "application/json",
    sha256: hashes.engineer,
    provenance: { source: "runtime-model-fixture" },
  });
  await insertArtifact(database, ids.runId, ids.referenceArtifactId, {
    logicalName: "reference-image.png",
    mediaType: "image/png",
    sha256: hashes.reference,
    provenance: { source: "runtime-model-fixture" },
  });
  await database.query(
    "INSERT INTO model_calls (id, run_id, role, model, endpoint_identity, request_sha256, response_sha256, status, model_egress_authorized, model_egress_performed, created_at, finished_at) VALUES (?, ?, 'engineer', 'runtime-engineer', 'runtime', ?, ?, 'passed', true, true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)), (?, ?, 'artist', 'runtime-artist', 'runtime', ?, ?, 'passed', true, true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [
      ids.engineerModelCallId,
      ids.runId,
      "7".repeat(64),
      hashes.engineer,
      ids.artistModelCallId,
      ids.runId,
      "8".repeat(64),
      hashes.reference,
    ],
  );
  await database.query(
    "INSERT INTO image_attempts (id, run_id, model_call_id, prompt_sha256, input_snapshot_sha256, generation_config_sha256, adapter_identity, output_artifact_id, status, direct_runtime_use_allowed, created_at) VALUES (?, ?, ?, ?, ?, ?, 'runtime-reference-only', ?, 'passed', false, CURRENT_TIMESTAMP(3))",
    [
      ids.imageAttemptId,
      ids.runId,
      ids.artistModelCallId,
      promptSha256,
      "9".repeat(64),
      "0".repeat(64),
      ids.referenceArtifactId,
    ],
  );
  const executionSql =
    "INSERT INTO profession_skill_model_executions (id, run_id, job_id, worker_id, lease_id, attempt, skill_id, stage, prompt_sha256, model_call_id, image_attempt_id, output_artifact_id, output_sha256, output_byte_length, status, created_at, updated_at, finished_at) VALUES (?, ?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, 128, 'passed', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))";
  await database.query(executionSql, [
    ids.engineerExecutionId,
    ids.runId,
    ids.jobId,
    workerId,
    ids.leaseId,
    ids.skillId,
    "engineer-plan-v1",
    promptSha256,
    ids.engineerModelCallId,
    null,
    ids.engineerArtifactId,
    hashes.engineer,
  ]);
  await database.query(executionSql, [
    ids.artistExecutionId,
    ids.runId,
    ids.jobId,
    workerId,
    ids.leaseId,
    ids.skillId,
    "reference-image-v1",
    promptSha256,
    ids.artistModelCallId,
    ids.imageAttemptId,
    ids.referenceArtifactId,
    hashes.reference,
  ]);
}

async function insertOutputUploads(
  database,
  { ids, workerId, projectsProvenance },
) {
  await insertArtifact(database, ids.runId, ids.projectsArtifactId, {
    logicalName: "projects.zip",
    mediaType: "application/zip",
    sha256: hashes.projects,
    provenance: projectsProvenance,
  });
  await insertArtifact(database, ids.runId, ids.validationArtifactId, {
    logicalName: "validation.zip",
    mediaType: "application/zip",
    sha256: hashes.validation,
    provenance: projectsProvenance,
  });
  await insertUpload(database, {
    uploadId: ids.projectsUploadId,
    artifactId: ids.projectsArtifactId,
    runId: ids.runId,
    jobId: ids.jobId,
    workerId,
    leaseId: ids.leaseId,
    logicalName: "projects.zip",
    sha256: hashes.projects,
    provenance: projectsProvenance,
  });
  await insertUpload(database, {
    uploadId: ids.validationUploadId,
    artifactId: ids.validationArtifactId,
    runId: ids.runId,
    jobId: ids.jobId,
    workerId,
    leaseId: ids.leaseId,
    logicalName: "validation.zip",
    sha256: hashes.validation,
    provenance: projectsProvenance,
  });
}

async function insertArtifact(
  database,
  runId,
  artifactId,
  { logicalName, mediaType, sha256, provenance },
) {
  await database.query(
    "INSERT INTO artifacts (id, run_id, logical_name, storage_key, media_type, byte_length, sha256, provenance, created_at) VALUES (?, ?, ?, ?, ?, 128, ?, ?, CURRENT_TIMESTAMP(3))",
    [
      artifactId,
      runId,
      logicalName,
      `artifacts/${artifactId}`,
      mediaType,
      sha256,
      JSON.stringify(provenance),
    ],
  );
}

async function insertUpload(
  database,
  {
    uploadId,
    artifactId,
    runId,
    jobId,
    workerId,
    leaseId,
    logicalName,
    sha256,
    provenance,
  },
) {
  await database.query(
    "INSERT INTO artifact_upload_sessions (id, run_id, job_id, worker_id, lease_id, attempt, object_key, logical_name, media_type, expected_byte_length, expected_sha256, provenance, status, artifact_id, expires_at, created_at, updated_at, finalized_at) VALUES (?, ?, ?, ?, ?, 2, ?, ?, 'application/zip', 128, ?, ?, 'finalized', ?, CURRENT_TIMESTAMP(3) + INTERVAL 5 MINUTE, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [
      uploadId,
      runId,
      jobId,
      workerId,
      leaseId,
      `artifacts/${artifactId}`,
      logicalName,
      sha256,
      JSON.stringify(provenance),
      artifactId,
    ],
  );
}
