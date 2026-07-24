/**
 * @fileoverview 通过真实 Worker HTTP 路由和隔离 MySQL 验证 Profession 单技能当前-attempt 接收事务。
 * @module scripts/runtime-test/profession-skill-production-scenario
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：api-scenario 在已有 Project/Snapshot/source Run/Worker 后调用；本模块建立专用数据库 fixture，
 * 提交旧 attempt、错误 provenance 与有效 passed 报告，检查稳定 HTTP 错误和最终持久化后清理。
 * 安全边界：通过只证明 Server DTO/事务/MySQL 约束，不证明真实模型、对象上传、Aseprite、NPK、
 * 客户端兼容或部署；任一拒绝分支后 production 必须保持未绑定。
 */
import { requestJson } from "./api-support.mjs";
import { assert } from "./process.mjs";
import {
  createProfessionSkillProductionFixture,
  removeProfessionSkillProductionFixture,
  repairValidationProvenance,
} from "./profession-skill-production-fixture.mjs";

/** 执行三条 HTTP 报告并证明只有完整当前 attempt 可以写入 passed 证据。 */
export async function exerciseProfessionSkillProduction({
  baseUrl,
  workerToken,
  database,
  projectId,
  snapshotId,
  sourceRunId,
  workerId,
}) {
  const fixture = await createProfessionSkillProductionFixture(database, {
    projectId,
    snapshotId,
    sourceRunId,
    workerId,
  });
  let completion;
  try {
    const path = `/internal/jobs/${fixture.ids.jobId}/skill-production`;
    const staleAttempt = await requestJson(
      baseUrl,
      path,
      {
        method: "POST",
        workerToken,
        body: { ...fixture.passedReport, attempt: 1 },
      },
      409,
    );
    assert(
      staleAttempt.code === "JOB_LEASE_MISMATCH",
      "Old Profession attempt was not rejected by the exact lease gate.",
    );
    await assertProductionUnchanged(database, fixture.ids.productionId);

    const wrongProvenance = await requestJson(
      baseUrl,
      path,
      { method: "POST", workerToken, body: fixture.passedReport },
      409,
    );
    assert(
      wrongProvenance.code === "STYLE_SKILL_ARTIFACT_EVIDENCE_MISMATCH",
      "Validation Artifact with the projects role was not rejected.",
    );
    await assertProductionUnchanged(database, fixture.ids.productionId);

    await repairValidationProvenance(database, fixture);
    const accepted = await requestJson(
      baseUrl,
      path,
      { method: "POST", workerToken, body: fixture.passedReport },
      201,
    );
    assert(
      accepted.status === "accepted",
      "Current Profession attempt was not accepted.",
    );
    await assertPassedProduction(database, fixture);
    await assertPassedCheckRejectsMissingWorker(database, fixture);
    completion = await completeProfessionAndAssertPackage({
      baseUrl,
      workerToken,
      database,
      fixture,
      workerId,
    });
  } finally {
    await removeProfessionSkillProductionFixture(database, fixture);
  }
  assert(
    completion !== undefined,
    "Profession completion scenario did not run.",
  );
  return {
    staleAttemptRejected: true,
    validationRoleMismatchRejected: true,
    currentAttemptPersisted: true,
    passedCheckEnforced: true,
    ...completion,
  };
}

async function completeProfessionAndAssertPackage({
  baseUrl,
  workerToken,
  database,
  fixture,
  workerId,
}) {
  const { ids } = fixture;
  const packageReport = await requestJson(
    baseUrl,
    `/internal/jobs/${ids.jobId}/package`,
    {
      method: "POST",
      workerToken,
      body: {
        workerId,
        leaseId: ids.leaseId,
        attempt: 2,
        status: "building",
      },
    },
    409,
  );
  assert(
    packageReport.code === "STYLE_PACKAGE_CAPABILITY_NOT_FROZEN",
    "Profession V2 accepted a package report without a frozen tool contract.",
  );
  const [beforeRows] = await database.query(
    "SELECT status, package_artifact_id AS packageArtifactId, finished_at AS finishedAt FROM style_packages WHERE id = ?",
    [ids.packageId],
  );
  assert(
    beforeRows.length === 1 &&
      beforeRows[0].status === "queued" &&
      beforeRows[0].packageArtifactId === null &&
      beforeRows[0].finishedAt === null,
    "Rejected package report changed the package row.",
  );
  const progress = await requestJson(
    baseUrl,
    `/internal/jobs/${ids.jobId}/profession-production-progress`,
    {
      method: "POST",
      workerToken,
      body: { workerId, leaseId: ids.leaseId, attempt: 2 },
    },
    201,
  );
  assert(
    progress.skills.length === 1 &&
      progress.skills[0].skillId === ids.skillId &&
      progress.skills[0].status === "passed" &&
      typeof progress.resultSha256 === "string",
    "Profession progress did not return the verified Server digest.",
  );
  await requestJson(
    baseUrl,
    `/internal/jobs/${ids.jobId}/complete`,
    {
      method: "POST",
      workerToken,
      body: {
        workerId,
        leaseId: ids.leaseId,
        status: "passed",
        resultSha256: progress.resultSha256,
      },
    },
    201,
  );
  const [rows] = await database.query(
    "SELECT jobs.status AS jobStatus, job_attempts.status AS attemptStatus, runs.status AS runStatus, style_packages.status AS packageStatus, style_packages.package_artifact_id AS packageArtifactId, style_packages.finished_at AS packageFinishedAt FROM jobs JOIN job_attempts ON job_attempts.job_id = jobs.id AND job_attempts.attempt = jobs.attempt_count JOIN runs ON runs.id = jobs.run_id JOIN style_packages ON style_packages.run_id = runs.id WHERE jobs.id = ?",
    [ids.jobId],
  );
  const row = rows[0];
  assert(
    rows.length === 1 &&
      row.jobStatus === "passed" &&
      row.attemptStatus === "passed" &&
      row.runStatus === "passed" &&
      row.packageStatus === "blocked" &&
      row.packageArtifactId === null &&
      row.packageFinishedAt instanceof Date,
    "Profession completion left its package queued or fabricated package evidence.",
  );
  return {
    unfrozenPackageReportRejected: true,
    completionAccepted: true,
    runStatusAfterCompletion: row.runStatus,
    packageStatusAfterCompletion: row.packageStatus,
    packageArtifactAvailable: row.packageArtifactId !== null,
  };
}

async function assertProductionUnchanged(database, productionId) {
  const [rows] = await database.query(
    "SELECT status, job_id AS jobId, worker_id AS workerId, lease_id AS leaseId, attempt, aseprite_upload_id AS asepriteUploadId, validation_upload_id AS validationUploadId, finished_at AS finishedAt FROM style_skill_productions WHERE id = ?",
    [productionId],
  );
  const production = rows[0];
  assert(
    rows.length === 1 &&
      production.status === "validating" &&
      production.jobId === null &&
      production.workerId === null &&
      production.leaseId === null &&
      production.attempt === null &&
      production.asepriteUploadId === null &&
      production.validationUploadId === null &&
      production.finishedAt === null,
    "Rejected Profession report changed production evidence.",
  );
}

async function assertPassedProduction(database, fixture) {
  const [rows] = await database.query(
    "SELECT status, job_id AS jobId, worker_id AS workerId, lease_id AS leaseId, attempt, model_call_id AS modelCallId, image_attempt_id AS imageAttemptId, aseprite_profile_id AS asepriteProfileId, aseprite_binary_sha256 AS binarySha256, aseprite_adapter_sha256 AS adapterSha256, aseprite_artifact_id AS projectsArtifactId, aseprite_upload_id AS projectsUploadId, validation_artifact_id AS validationArtifactId, validation_upload_id AS validationUploadId, error_code AS errorCode, finished_at AS finishedAt FROM style_skill_productions WHERE id = ?",
    [fixture.ids.productionId],
  );
  const production = rows[0];
  assert(
    rows.length === 1 &&
      production.status === "passed" &&
      production.jobId === fixture.ids.jobId &&
      production.workerId === fixture.workerId &&
      production.leaseId === fixture.ids.leaseId &&
      production.attempt === 2 &&
      production.modelCallId === fixture.ids.artistModelCallId &&
      production.imageAttemptId === fixture.ids.imageAttemptId &&
      production.asepriteProfileId === "aseprite-cli" &&
      production.binarySha256 === fixture.passedReport.asepriteBinarySha256 &&
      production.adapterSha256 === fixture.passedReport.asepriteAdapterSha256 &&
      production.projectsArtifactId === fixture.ids.projectsArtifactId &&
      production.projectsUploadId === fixture.ids.projectsUploadId &&
      production.validationArtifactId === fixture.ids.validationArtifactId &&
      production.validationUploadId === fixture.ids.validationUploadId &&
      production.errorCode === null &&
      production.finishedAt !== null,
    "Accepted Profession report did not persist the complete Server-derived evidence chain.",
  );
}

async function assertPassedCheckRejectsMissingWorker(database, fixture) {
  try {
    await database.query(
      "UPDATE style_skill_productions SET worker_id = NULL WHERE id = ?",
      [fixture.ids.productionId],
    );
  } catch (error) {
    assert(
      error?.code === "ER_CHECK_CONSTRAINT_VIOLATED",
      "Invalid passed evidence failed without the MySQL CHECK error.",
    );
    return;
  }
  throw new Error("MySQL accepted passed production without worker evidence.");
}
