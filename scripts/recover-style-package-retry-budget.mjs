/**
 * @fileoverview 为已被 Package 输入兼容问题阻断的同一 Job 扩展或复用有限重试预算；
 * 保留全部历史 JobAttempt 与 style_package_attempt_evidences，不修改冻结 payload/profile。
 * @module scripts/operations
 * @author AI生成
 * @created 2026-07-28
 * @relatedPlan N/A - 剑魂全技能 Package V3 实机恢复
 *
 * 调用关系：维护者先执行 dry-run，再显式增加 `--apply`；脚本直连当前 Server MySQL，
 * 不调用 Worker、对象存储或封包工具。输入必须固定 Run、当前 attempt 数、最新稳定错误码
 * 与迁移前后 profile SHA，输出只包含迁移摘要和四项不可提升的安全状态。
 *
 * 副作用：dry-run 在事务末尾回滚；apply 仅把同一 Package Job/Run/style_package 重排、
 * 将 maxAttempts 封顶为 10，并追加 RunEvent/outbox。attempt_count、payload、历史 attempt、
 * evidence、Artifact 和上传会话都不会被删除、覆盖或伪造。
 *
 * 安全边界：必须证明 Profession 已 passed、Package 当前 blocked 且无 lease、每个历史
 * attempt 与 evidence 一一匹配、没有任何 Package 输出、31 技能证据仍 passed、四项安全位
 * 全 false。任一事实漂移都整体回滚；恢复不授权部署，也不证明全技能覆盖或客户端兼容。
 */
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import {
  falseSafety,
  hasFalseSafety,
  jsonValue,
  mysqlUtcToIso,
  requiredDatabaseUrl,
  requireDatabaseTime,
  sha256JcsV1,
  sha256LegacyJson,
  stableErrorCode,
} from "./recover-style-package-profile-support.mjs";
const targetMaxAttempts = 10;
const packageLogicalNames = [
  "candidate.npk",
  "package-manifest.json",
  "package-validation.json",
];
const stableCodePattern = /^[A-Z][A-Z0-9_]{0,79}$/u;
try {
  await main();
} catch (error) {
  process.stderr.write(`${stableErrorCode(error)}\n`);
  process.exitCode = 1;
}
/** 解析受限 CLI、连接当前数据库，并确保成功或失败都关闭会话。 */
async function main() {
  const input = parseArguments(process.argv.slice(2));
  const database = await mysql.createConnection({
    uri: requiredDatabaseUrl(process.env.DATABASE_URL),
    dateStrings: true,
  });
  try {
    const result = await recoverRetryBudget(database, input);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await database.end();
  }
}

/**
 * 锁定完整恢复边界并预演或提交重排。
 * @param {import("mysql2/promise").Connection} database 当前 Server 数据库会话。
 * @param {{runId:string,expectedAttempt:number,expectedErrorCode:string,expectedProfileSha256:string,expectedInitialProfileSha256:string,apply:boolean}} input 精确恢复条件。
 */
async function recoverRetryBudget(database, input) {
  await database.beginTransaction();
  try {
    const run = await requireSingleRow(
      database,
      "SELECT * FROM runs WHERE id = ? FOR UPDATE",
      [input.runId],
      "RUN_NOT_FOUND",
    );
    requireRunSafety(run);

    const [jobRows] = await database.execute(
      "SELECT * FROM jobs WHERE run_id = ? ORDER BY kind FOR UPDATE",
      [input.runId],
    );
    const { packageJob } = requireJobs(jobRows, input.expectedAttempt);
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
    requireUnbuiltStylePackage(stylePackage, packagePayload);

    const [attempts] = await database.execute(
      "SELECT * FROM job_attempts WHERE job_id = ? ORDER BY attempt FOR UPDATE",
      [packageJob.id],
    );
    const [evidences] = await database.execute(
      "SELECT * FROM style_package_attempt_evidences WHERE job_id = ? ORDER BY attempt FOR UPDATE",
      [packageJob.id],
    );
    requirePreservedAttempts(
      packageJob,
      attempts,
      evidences,
      input.expectedAttempt,
      input.expectedErrorCode,
      input.expectedProfileSha256,
      input.expectedInitialProfileSha256,
    );
    await requireProfileMigrationAudit(database, input);

    await requireNoPackageOutputs(database, input.runId, packageJob.id);
    await requirePassedSkills(
      database,
      input.runId,
      packagePayload.parameters.selectedSkillIds,
    );

    const [timeRows] = await database.execute(
      "SELECT UTC_TIMESTAMP(3) AS databaseTime",
    );
    const databaseTime = requireDatabaseTime(timeRows[0]?.databaseTime);
    const sequence = await nextRunEventSequence(database, input.runId);
    const event = retryRecoveryEvent(
      input.runId,
      sequence,
      databaseTime,
      input.expectedAttempt,
      input.expectedErrorCode,
    );

    if (input.apply) {
      await database.execute(
        "UPDATE jobs SET status = 'queued', max_attempts = ?, dispatch_ready_at = ?, updated_at = ? WHERE id = ?",
        [targetMaxAttempts, databaseTime, databaseTime, packageJob.id],
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
      initialPackageProfileSha256: input.expectedInitialProfileSha256,
      packageProfileSha256: input.expectedProfileSha256,
      eventSequence: sequence,
      safety: falseSafety(),
    };
  } catch (error) {
    await database.rollback();
    throw error;
  }
}

/** 固定五参数及可选 `--apply`；默认只执行可回滚预演。 */
function parseArguments(arguments_) {
  const apply = arguments_.includes("--apply");
  const values = arguments_.filter((value) => value !== "--apply");
  if (values.length !== 5) throw new Error("USAGE_INVALID");
  const [
    runId,
    expectedAttemptText,
    expectedErrorCode,
    profileSha256,
    initialProfileSha256,
  ] = values;
  const expectedAttempt = Number(expectedAttemptText);
  if (!isUuid(runId)) throw new Error("RUN_ID_INVALID");
  if (
    !Number.isSafeInteger(expectedAttempt) ||
    expectedAttempt < 1 ||
    expectedAttempt >= targetMaxAttempts
  ) {
    throw new Error("EXPECTED_ATTEMPT_INVALID");
  }
  if (!stableCodePattern.test(expectedErrorCode)) {
    throw new Error("EXPECTED_ERROR_CODE_INVALID");
  }
  if (
    !/^[A-F0-9]{64}$/iu.test(profileSha256) ||
    !/^[A-F0-9]{64}$/iu.test(initialProfileSha256) ||
    profileSha256.toUpperCase() === initialProfileSha256.toUpperCase()
  ) {
    throw new Error("PROFILE_SHA256_INVALID");
  }
  return {
    runId: runId.toLowerCase(),
    expectedAttempt,
    expectedErrorCode,
    expectedProfileSha256: profileSha256.toUpperCase(),
    expectedInitialProfileSha256: initialProfileSha256.toUpperCase(),
    apply,
  };
}

/** 只允许一个 blocked Package 与一个已 passed Profession Job，且 Package 无活动 lease。 */
function requireJobs(rows, expectedAttempt) {
  if (rows.length !== 2) throw new Error("RUN_JOB_CARDINALITY_INVALID");
  const professionJob = rows.find((row) => row.kind === "profession");
  const packageJob = rows.find((row) => row.kind === "npk-package");
  if (!professionJob || !packageJob) throw new Error("RUN_JOB_KINDS_INVALID");
  if (professionJob.status !== "passed") {
    throw new Error("PROFESSION_JOB_NOT_PASSED");
  }
  const leaseEmpty = [
    packageJob.lease_owner_id,
    packageJob.lease_id,
    packageJob.lease_expires_at,
  ].every((value) => value === null);
  const maxAttempts = Number(packageJob.max_attempts);
  if (
    packageJob.status !== "blocked" ||
    Number(packageJob.attempt_count) !== expectedAttempt ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < expectedAttempt ||
    maxAttempts > targetMaxAttempts ||
    !leaseEmpty
  ) {
    throw new Error("PACKAGE_JOB_NOT_RECOVERABLE");
  }
  return { packageJob };
}

/** 验证冻结 payload/profile 未漂移，并恢复预期技能集合。 */
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
  return payload;
}

/** Package 聚合只能是无三产物的 blocked 状态，且仍绑定冻结职业和风格。 */
function requireUnbuiltStylePackage(stylePackage, payload) {
  if (
    stylePackage.status !== "blocked" ||
    stylePackage.package_artifact_id !== null ||
    stylePackage.manifest_sha256 !== null ||
    stylePackage.finished_at === null ||
    stylePackage.profession_id !== payload.parameters.professionId ||
    stylePackage.style_id !== payload.parameters.styleId
  ) {
    throw new Error("STYLE_PACKAGE_ALREADY_BUILT");
  }
}

/**
 * 逐轮验证 attempt/evidence 的 fencing 身份、终态、错误码和空输出；历史行只读不改写。
 * 正常业务阻断必须具有同码 blocked evidence；Server 重启后的 lease reaper 只允许
 * `timed_out/LEASE_EXPIRED` 对应尚未终结的 building evidence，不能伪装成业务阻断。
 */
function requirePreservedAttempts(
  packageJob,
  attempts,
  evidences,
  expectedAttempt,
  expectedErrorCode,
  expectedProfileSha256,
  expectedInitialProfileSha256,
) {
  if (
    attempts.length !== expectedAttempt ||
    evidences.length !== expectedAttempt
  ) {
    throw new Error("PACKAGE_ATTEMPT_CARDINALITY_INVALID");
  }
  for (let index = 0; index < expectedAttempt; index += 1) {
    const attemptNumber = index + 1;
    const attempt = attempts[index];
    const evidence = evidences[index];
    const expectedEvidenceProfileSha256 =
      attemptNumber === 1
        ? expectedInitialProfileSha256
        : expectedProfileSha256;
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
    if (
      Number(attempt?.attempt) !== attemptNumber ||
      attempt.finished_at === null ||
      Number(evidence?.attempt) !== attemptNumber ||
      evidence.job_id !== packageJob.id ||
      (!blockedAttempt && !timedOutAttempt) ||
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
    attempts.at(-1).status !== "blocked" ||
    attempts.at(-1).error_code !== expectedErrorCode ||
    evidences.at(-1).status !== "blocked" ||
    evidences.at(-1).error_code !== expectedErrorCode
  ) {
    throw new Error("PACKAGE_LATEST_ERROR_MISMATCH");
  }
}

/** 旧 profile 只因既有 attempt 1→2 迁移而合法；事件必须同时绑定旧、新 SHA。 */
async function requireProfileMigrationAudit(database, input) {
  const [rows] = await database.execute(
    "SELECT sequence, level, stage, message FROM run_events WHERE run_id = ? AND message LIKE 'Package attempt 1%' FOR UPDATE",
    [input.runId],
  );
  const matches = rows.filter(
    (row) =>
      row.level === "warning" &&
      row.stage === "queued" &&
      row.message.includes(
        `profile 从 ${input.expectedInitialProfileSha256}`,
      ) &&
      row.message.includes(`迁移到 ${input.expectedProfileSha256}`) &&
      row.message.includes("已开放 attempt 2") &&
      row.message.includes("部署保持禁用"),
  );
  if (matches.length !== 1) {
    throw new Error("PACKAGE_PROFILE_MIGRATION_AUDIT_INVALID");
  }
}

/** 任一三产物 Artifact/SHA/upload 字段非空都拒绝恢复。 */
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

/** 任何 Package 上传会话或三项逻辑名 Artifact 都说明恢复边界不再成立。 */
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

/** 全部 production 必须与冻结技能集合一一对应且 passed，不重新运行 Profession。 */
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

/** blocked Run 必须由当前 Package 导致，四项不可提升状态严格保持 false。 */
function requireRunSafety(run) {
  if (
    run.status !== "blocked" ||
    run.current_stage !== "blocked" ||
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

/** 审计事件只记录保留轮次、有限稳定码和预算，不包含路径、对象、正文或工具输出。 */
function retryRecoveryEvent(
  runId,
  sequence,
  databaseTime,
  expectedAttempt,
  expectedErrorCode,
) {
  return {
    runId,
    sequence,
    level: "warning",
    stage: "queued",
    message: `Package attempts 1-${expectedAttempt} 及其阻断证据已保留；最新稳定码 ${expectedErrorCode} 经受限恢复后开放 attempt ${expectedAttempt + 1}，总预算封顶 ${targetMaxAttempts}。部署保持禁用。`,
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

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}
