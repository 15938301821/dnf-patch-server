/**
 * @fileoverview 为已进入多轮 Package 阻断的同一 Job 迁移固定 Packager/Validator profile。
 *
 * 调用链：维护者先 dry-run，再显式 `--apply`；脚本直连当前 MySQL，不调用 Worker、对象存储
 * 或本机工具。输入是 Run UUID、当前 attempt、最新稳定错误码、旧/初始 profile 摘要和新工具
 * SHA。输出只包含迁移摘要，不包含 payload、路径、凭据或对象 key。
 *
 * 副作用：dry-run 在事务末尾回滚；apply 在一个事务中更新同一 npk-package Job 的冻结
 * payload/profile 摘要，把 Run/Package 重排为 queued，并追加 RunEvent/outbox。历史
 * job_attempts、style_package_attempt_evidences、Artifact 和上传会话均只读不改。
 *
 * 安全边界：必须证明四项安全位全 false、Profession 已 passed、Package 当前 failed/blocked
 * 且无 lease、1..N attempts 与 evidences 一一匹配、三段 profile epoch 和两次历史迁移事件
 * 精确一致、最新错误码匹配、无 Package 三产物输出、技能 evidence 完整。任一事实漂移都
 * 整体回滚；恢复不授权部署，也不证明全技能覆盖或客户端兼容。
 */
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import {
  falseSafety,
  hasFalseSafety,
  jsonValue,
  mysqlUtcToIso,
  parseCurrentProfileArguments,
  requiredDatabaseUrl,
  requireDatabaseTime,
  sha256JcsV1,
  sha256LegacyJson,
  stableCodePattern,
  stableErrorCode,
  targetMaxAttempts,
} from "./recover-style-package-profile-support.mjs";

const packageLogicalNames = [
  "candidate.npk",
  "package-manifest.json",
  "package-validation.json",
];

try {
  await main();
} catch (error) {
  process.stderr.write(`${stableErrorCode(error)}\n`);
  process.exitCode = 1;
}

async function main() {
  const input = parseCurrentProfileArguments(process.argv.slice(2));
  const database = await mysql.createConnection({
    uri: requiredDatabaseUrl(process.env.DATABASE_URL),
    dateStrings: true,
  });
  try {
    const result = await migrateCurrentProfile(database, input);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await database.end();
  }
}

/**
 * 锁定完整恢复边界并预演或提交迁移。
 * @param {import("mysql2/promise").Connection} database 当前 Server 数据库会话。
 * @param {{runId:string,expectedAttempt:number,expectedErrorCode:string,expectedProfileSha256:string,expectedInitialProfileSha256:string,expectedIntermediateProfileSha256:string,packagerSha256:string,validatorSha256:string,apply:boolean}} input CLI 参数。
 */
async function migrateCurrentProfile(database, input) {
  await database.beginTransaction();
  try {
    const run = await requireSingleRow(
      database,
      "SELECT * FROM runs WHERE id = ? FOR UPDATE",
      [input.runId],
      "RUN_NOT_FOUND",
    );
    const [jobRows] = await database.execute(
      "SELECT * FROM jobs WHERE run_id = ? ORDER BY kind FOR UPDATE",
      [input.runId],
    );
    const packageJob = requirePackageJob(jobRows, input.expectedAttempt);
    requireRunSafety(run, packageJob.status);
    const packagePayload = requirePackagePayload(
      packageJob,
      input.expectedProfileSha256,
    );

    const stylePackage = await requireSingleRow(
      database,
      "SELECT * FROM style_packages WHERE run_id = ? FOR UPDATE",
      [input.runId],
      "STYLE_PACKAGE_NOT_FOUND",
    );
    requireUnbuiltStylePackage(stylePackage, packagePayload, packageJob.status);

    const [attempts] = await database.execute(
      "SELECT * FROM job_attempts WHERE job_id = ? ORDER BY attempt FOR UPDATE",
      [packageJob.id],
    );
    const [evidences] = await database.execute(
      "SELECT * FROM style_package_attempt_evidences WHERE job_id = ? ORDER BY attempt FOR UPDATE",
      [packageJob.id],
    );
    requirePreservedAttempts(packageJob, attempts, evidences, input);
    await requirePriorProfileMigrationAudit(database, input);
    await requireNoPackageOutputs(database, input.runId, packageJob.id);
    await requirePassedSkills(
      database,
      input.runId,
      packagePayload.parameters.selectedSkillIds,
    );

    const migratedPayload = structuredClone(packagePayload);
    migratedPayload.parameters.packageProfile.packager.sha256 =
      input.packagerSha256;
    migratedPayload.parameters.packageProfile.validator.sha256 =
      input.validatorSha256;
    const oldProfileSha256 =
      packagePayload.parameters.packageProfileSha256.toUpperCase();
    const newProfileSha256 = sha256JcsV1(
      migratedPayload.parameters.packageProfile,
    );
    migratedPayload.parameters.packageProfileSha256 = newProfileSha256;
    const newPayloadSha256 = sha256LegacyJson(migratedPayload);
    if (
      newProfileSha256 === oldProfileSha256 ||
      newPayloadSha256 === packageJob.payload_sha256.toUpperCase()
    ) {
      throw new Error("PACKAGE_PROFILE_MIGRATION_HAS_NO_CHANGE");
    }

    const [timeRows] = await database.execute(
      "SELECT UTC_TIMESTAMP(3) AS databaseTime",
    );
    const databaseTime = requireDatabaseTime(timeRows[0]?.databaseTime);
    const sequence = await nextRunEventSequence(database, input.runId);
    const event = profileMigrationEvent(
      input.runId,
      sequence,
      databaseTime,
      input.expectedAttempt,
      input.expectedErrorCode,
      oldProfileSha256,
      newProfileSha256,
    );

    if (input.apply) {
      await database.execute(
        "UPDATE jobs SET status = 'queued', max_attempts = ?, payload = ?, payload_sha256 = ?, dispatch_ready_at = ?, updated_at = ? WHERE id = ?",
        [
          targetMaxAttempts,
          JSON.stringify(migratedPayload),
          newPayloadSha256,
          databaseTime,
          databaseTime,
          packageJob.id,
        ],
      );
      await database.execute(
        "UPDATE style_packages SET status = 'queued', updated_at = ?, finished_at = NULL WHERE id = ?",
        [databaseTime, stylePackage.id],
      );
      await database.execute(
        "UPDATE runs SET status = 'queued', current_stage = 'queued', updated_at = ?, finished_at = NULL WHERE id = ?",
        [databaseTime, input.runId],
      );
      await database.execute(
        "INSERT INTO run_events (id, run_id, sequence, level, stage, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          randomUUID(),
          input.runId,
          sequence,
          event.level,
          event.stage,
          event.message,
          databaseTime,
        ],
      );
      await database.execute(
        "INSERT INTO outbox_events (id, topic, aggregate_id, payload, created_at) VALUES (?, 'run.event', ?, ?, ?)",
        [randomUUID(), input.runId, JSON.stringify(event), databaseTime],
      );
      await database.commit();
    } else {
      await database.rollback();
    }

    return {
      schemaVersion: 1,
      status: input.apply ? "requeued" : "dry-run",
      runId: input.runId,
      packageJobId: packageJob.id,
      preservedAttempts: input.expectedAttempt,
      nextAttempt: input.expectedAttempt + 1,
      previousMaxAttempts: Number(packageJob.max_attempts),
      maxAttempts: targetMaxAttempts,
      oldProfileSha256,
      newProfileSha256,
      newPayloadSha256,
      eventSequence: sequence,
      safety: falseSafety(),
    };
  } catch (error) {
    await database.rollback();
    throw error;
  }
}

function requirePackageJob(rows, expectedAttempt) {
  if (rows.length !== 2) throw new Error("RUN_JOB_CARDINALITY_INVALID");
  const professionJob = rows.find((row) => row.kind === "profession");
  const packageJob = rows.find((row) => row.kind === "npk-package");
  if (!professionJob || !packageJob) throw new Error("RUN_JOB_KINDS_INVALID");
  if (professionJob.status !== "passed")
    throw new Error("PROFESSION_JOB_NOT_PASSED");
  const leaseEmpty = [
    packageJob.lease_owner_id,
    packageJob.lease_id,
    packageJob.lease_expires_at,
  ].every((value) => value === null);
  const maxAttempts = Number(packageJob.max_attempts);
  if (
    !["blocked", "failed"].includes(packageJob.status) ||
    Number(packageJob.attempt_count) !== expectedAttempt ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < expectedAttempt ||
    maxAttempts > targetMaxAttempts ||
    !leaseEmpty
  ) {
    throw new Error("PACKAGE_JOB_NOT_RECOVERABLE");
  }
  return packageJob;
}

function requirePackagePayload(job, expectedProfileSha256) {
  const payload = jsonValue(job.payload);
  const parameters = payload?.parameters;
  const profile = parameters?.packageProfile;
  if (
    payload?.schemaVersion !== 1 ||
    payload?.profileId !== "npk-package-v3" ||
    parameters?.workflow !== "style-package-production-v3" ||
    profile?.schemaVersion !== 3 ||
    profile?.profileId !== payload.profileId ||
    parameters?.packageProfileSha256?.toUpperCase() !== expectedProfileSha256 ||
    sha256JcsV1(profile) !== expectedProfileSha256 ||
    sha256LegacyJson(payload) !== job.payload_sha256.toUpperCase() ||
    !hasFalseSafety(parameters?.safety) ||
    !Array.isArray(parameters?.selectedSkillIds) ||
    parameters.selectedSkillIds.length < 1 ||
    parameters.selectedSkillIds.length > 500 ||
    new Set(parameters.selectedSkillIds).size !==
      parameters.selectedSkillIds.length
  ) {
    throw new Error("PACKAGE_JOB_PAYLOAD_INVALID");
  }
  for (const tool of [
    profile.packager,
    profile.validator,
    profile.directXTex,
    profile.extractorSharp,
  ]) {
    if (!tool || typeof tool.toolId !== "string") {
      throw new Error("PACKAGE_JOB_PROFILE_INVALID");
    }
  }
  return payload;
}

function requireUnbuiltStylePackage(stylePackage, payload, expectedStatus) {
  if (
    stylePackage.status !== expectedStatus ||
    stylePackage.package_artifact_id !== null ||
    stylePackage.manifest_sha256 !== null ||
    stylePackage.finished_at === null ||
    stylePackage.profession_id !== payload.parameters.professionId ||
    stylePackage.style_id !== payload.parameters.styleId
  ) {
    throw new Error("STYLE_PACKAGE_ALREADY_BUILT");
  }
}

function requirePreservedAttempts(packageJob, attempts, evidences, input) {
  if (
    attempts.length !== input.expectedAttempt ||
    evidences.length !== input.expectedAttempt
  ) {
    throw new Error("PACKAGE_ATTEMPT_CARDINALITY_INVALID");
  }
  for (let index = 0; index < input.expectedAttempt; index += 1) {
    const attemptNumber = index + 1;
    const attempt = attempts[index];
    const evidence = evidences[index];
    const expectedEvidenceProfileSha256 =
      attemptNumber === 1
        ? input.expectedInitialProfileSha256
        : attemptNumber === input.expectedAttempt
          ? input.expectedProfileSha256
          : input.expectedIntermediateProfileSha256;
    const blockedAttempt =
      attempt?.status === "blocked" &&
      stableCodePattern.test(attempt.error_code ?? "") &&
      evidence?.status === "blocked" &&
      evidence.error_code === attempt.error_code &&
      evidence.finished_at !== null;
    const timedOutAttempt =
      attempt?.status === "timed_out" &&
      attempt.error_code === "LEASE_EXPIRED" &&
      evidence?.status === "building" &&
      evidence.error_code === null &&
      evidence.finished_at === null;
    const failedAttempt =
      attempt?.status === "failed" &&
      stableCodePattern.test(attempt.error_code ?? "") &&
      evidence?.status === "failed" &&
      evidence.error_code === attempt.error_code &&
      evidence.finished_at !== null;
    if (
      Number(attempt?.attempt) !== attemptNumber ||
      attempt.finished_at === null ||
      Number(evidence?.attempt) !== attemptNumber ||
      evidence.job_id !== packageJob.id ||
      (!blockedAttempt && !timedOutAttempt && !failedAttempt) ||
      evidence.worker_id !== attempt.worker_id ||
      evidence.lease_id !== attempt.lease_id ||
      evidence.package_profile_sha256.toUpperCase() !==
        expectedEvidenceProfileSha256 ||
      hasAnyPackageOutput(evidence) ||
      !hasFalseSafety(jsonValue(evidence.safety))
    ) {
      throw new Error("PACKAGE_ATTEMPT_EVIDENCE_INVALID");
    }
  }
  if (
    attempts.at(-1).status !== packageJob.status ||
    attempts.at(-1).error_code !== input.expectedErrorCode ||
    evidences.at(-1).status !== packageJob.status ||
    evidences.at(-1).error_code !== input.expectedErrorCode
  ) {
    throw new Error("PACKAGE_LATEST_ERROR_MISMATCH");
  }
}

async function requirePriorProfileMigrationAudit(database, input) {
  const [rows] = await database.execute(
    "SELECT level, stage, message FROM run_events WHERE run_id = ? AND message LIKE '%工具 profile 从%' FOR UPDATE",
    [input.runId],
  );
  const firstMigration = rows.filter((row) =>
    isProfileMigrationEvent(
      row,
      input.expectedInitialProfileSha256,
      input.expectedIntermediateProfileSha256,
      2,
    ),
  );
  const secondMigration = rows.filter((row) =>
    isProfileMigrationEvent(
      row,
      input.expectedIntermediateProfileSha256,
      input.expectedProfileSha256,
      input.expectedAttempt,
    ),
  );
  if (
    rows.length !== 2 ||
    firstMigration.length !== 1 ||
    secondMigration.length !== 1
  ) {
    throw new Error("PACKAGE_PROFILE_MIGRATION_AUDIT_INVALID");
  }
}

/** 历史事件必须同时绑定旧/新完整 SHA、开放轮次和部署禁用声明。 */
function isProfileMigrationEvent(
  row,
  oldProfileSha256,
  newProfileSha256,
  nextAttempt,
) {
  return (
    row.level === "warning" &&
    row.stage === "queued" &&
    row.message.includes(`profile 从 ${oldProfileSha256}`) &&
    row.message.includes(`迁移到 ${newProfileSha256}`) &&
    row.message.includes(`已开放 attempt ${nextAttempt}`) &&
    row.message.includes("部署保持禁用")
  );
}

function hasAnyPackageOutput(evidence) {
  return [
    evidence.package_artifact_id,
    evidence.package_sha256,
    evidence.package_upload_id,
    evidence.manifest_artifact_id,
    evidence.manifest_sha256,
    evidence.manifest_upload_id,
    evidence.validation_artifact_id,
    evidence.validation_sha256,
    evidence.validation_upload_id,
  ].some((value) => value !== null);
}

async function requireNoPackageOutputs(database, runId, jobId) {
  const [uploadRows] = await database.execute(
    "SELECT id FROM artifact_upload_sessions WHERE run_id = ? AND job_id = ? FOR UPDATE",
    [runId, jobId],
  );
  const placeholders = packageLogicalNames.map(() => "?").join(",");
  const [artifactRows] = await database.execute(
    `SELECT id FROM artifacts WHERE run_id = ? AND logical_name IN (${placeholders}) FOR UPDATE`,
    [runId, ...packageLogicalNames],
  );
  if (uploadRows.length !== 0 || artifactRows.length !== 0) {
    throw new Error("PACKAGE_OUTPUT_EVIDENCE_EXISTS");
  }
}

async function requirePassedSkills(database, runId, expectedSkillIds) {
  const [rows] = await database.execute(
    "SELECT skill_id AS skillId, status, error_code AS errorCode, finished_at AS finishedAt FROM style_skill_productions WHERE run_id = ? FOR UPDATE",
    [runId],
  );
  const byId = new Map(rows.map((row) => [row.skillId, row]));
  if (
    rows.length !== expectedSkillIds.length ||
    byId.size !== rows.length ||
    expectedSkillIds.some((skillId) => {
      const row = byId.get(skillId);
      return (
        !row ||
        row.status !== "passed" ||
        row.errorCode !== null ||
        row.finishedAt === null
      );
    })
  ) {
    throw new Error("PACKAGE_SKILL_EVIDENCE_INCOMPLETE");
  }
}

function requireRunSafety(run, expectedStatus) {
  if (
    run.status !== expectedStatus ||
    run.current_stage !== expectedStatus ||
    run.finished_at === null ||
    !hasFalseSafety({
      deploymentAuthorized: Boolean(run.deployment_authorized),
      deploymentPerformed: Boolean(run.deployment_performed),
      fullSkillCoverageProven: Boolean(run.full_skill_coverage_proven),
      clientCompatibilityProven: Boolean(run.client_compatibility_proven),
    })
  ) {
    throw new Error("RUN_NOT_RECOVERABLE");
  }
}

function profileMigrationEvent(
  runId,
  sequence,
  databaseTime,
  expectedAttempt,
  expectedErrorCode,
  oldProfileSha256,
  newProfileSha256,
) {
  return {
    runId,
    sequence,
    level: "warning",
    stage: "queued",
    message: `Package attempts 1-${expectedAttempt} 及其阻断证据已保留；最新稳定码 ${expectedErrorCode} 后，工具 profile 从 ${oldProfileSha256} 迁移到 ${newProfileSha256}，已开放 attempt ${expectedAttempt + 1}。部署保持禁用。`,
    createdAtUtc: mysqlUtcToIso(databaseTime),
  };
}

async function nextRunEventSequence(database, runId) {
  const [rows] = await database.execute(
    "SELECT COALESCE(MAX(sequence), -1) + 1 AS nextSequence FROM run_events WHERE run_id = ?",
    [runId],
  );
  const value = Number(rows[0]?.nextSequence);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("RUN_EVENT_SEQUENCE_INVALID");
  }
  return value;
}

async function requireSingleRow(database, statement, parameters, errorCode) {
  const [rows] = await database.execute(statement, parameters);
  if (rows.length !== 1) throw new Error(errorCode);
  return rows[0];
}
