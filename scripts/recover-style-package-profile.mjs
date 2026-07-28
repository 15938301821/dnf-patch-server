/**
 * @fileoverview 为已证明受旧 Packager profile 阻断或失败的 Package Job 迁移工具 profile；保留旧
 * JobAttempt 和 style_package_attempt_evidences，不删除、不伪造也不覆盖任何历史证据。
 * @module scripts/operations
 * @author AI生成
 * @created 2026-07-28
 * @relatedPlan N/A - 剑魂多官方 NPK 来源 Package V3 实机恢复
 *
 * 调用关系：维护者先执行 dry-run，再显式增加 `--apply`；脚本直连当前 Server MySQL，不调用
 * Worker、对象存储、模型或本机打包工具。输入是 Run UUID、预期旧 profile 摘要和新 Packager/
 * Validator SHA-256，以及预期稳定错误码，输出是不含 payload、路径和凭据的迁移摘要。
 *
 * 副作用：dry-run 在事务末尾回滚；apply 在一个事务中更新同一 npk-package Job 的冻结 payload
 * 与摘要，把 Run/Package 恢复为 queued，并追加权威 RunEvent/outbox。attempt_count 保持不变，
 * 下一次正常 claim 才创建新 lease 和 attempt。
 *
 * 安全边界：仅接受四项安全位全 false、Profession 已 passed、Package attempt 1 精确命中恢复
 * 白名单且 Run/Job/attempt/evidence/聚合终态一致、无 Package 上传或三产物、Factory contract
 * 仍冻结同一 profile 的 Run。任一
 * 前置条件漂移均整体回滚；脚本不能授权部署、证明全技能覆盖或证明客户端兼容。
 */
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import {
  falseSafety,
  hasFalseSafety,
  jsonValue,
  mysqlUtcToIso,
  parseArguments,
  requiredDatabaseUrl,
  requireDatabaseTime,
  sha256JcsV1,
  sha256LegacyJson,
  stableErrorCode,
} from "./recover-style-package-profile-support.mjs";

const recoverableErrorCodes = new Set([
  "STYLE_PACKAGE_INPUT_ARCHIVE_INVALID",
  "STYLE_PACKAGE_PACKAGER_FAILED",
]);
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

/** 解析受限 CLI、连接当前数据库，并确保成功或失败都关闭会话。 */
async function main() {
  const input = parseArguments(process.argv.slice(2));
  const databaseUrl = requiredDatabaseUrl(process.env.DATABASE_URL);
  const database = await mysql.createConnection({
    uri: databaseUrl,
    dateStrings: true,
  });
  try {
    const result = await migrateProfile(database, input);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await database.end();
  }
}

/**
 * 锁定并复核完整证据链，随后预演或提交同一 Job 的 profile 迁移。
 * @param {import("mysql2/promise").Connection} database 当前 Server 数据库会话。
 * @param {{runId:string,expectedErrorCode:string,expectedProfileSha256:string,packagerSha256:string,validatorSha256:string,apply:boolean}} input 已校验 CLI。
 */
async function migrateProfile(database, input) {
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
    const { packageJob } = requireJobs(jobRows);
    requireRunSafety(run, packageJob.status);
    const packagePayload = requirePackagePayload(
      packageJob,
      input.expectedProfileSha256,
    );

    const factory = await requireSingleRow(
      database,
      "SELECT f.config, f.config_sha256 AS configSha256 FROM projects p JOIN factories f ON f.id = p.factory_id WHERE p.id = ? FOR UPDATE",
      [run.project_id],
      "FACTORY_NOT_FOUND",
    );
    requireFactoryContract(factory, packagePayload.profileId);

    const stylePackage = await requireSingleRow(
      database,
      "SELECT * FROM style_packages WHERE run_id = ? FOR UPDATE",
      [input.runId],
      "STYLE_PACKAGE_NOT_FOUND",
    );
    requireUnbuiltStylePackage(stylePackage, packagePayload, packageJob.status);

    const attempt = await requireSingleRow(
      database,
      "SELECT * FROM job_attempts WHERE job_id = ? AND attempt = 1 FOR UPDATE",
      [packageJob.id],
      "PACKAGE_ATTEMPT_NOT_FOUND",
    );
    const evidence = await requireSingleRow(
      database,
      "SELECT * FROM style_package_attempt_evidences WHERE job_id = ? AND attempt = 1 FOR UPDATE",
      [packageJob.id],
      "PACKAGE_ATTEMPT_EVIDENCE_NOT_FOUND",
    );
    requireRecoverableAttempt(packageJob, attempt, evidence, input);

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
      input.expectedErrorCode,
      oldProfileSha256,
      newProfileSha256,
    );

    if (input.apply) {
      await database.execute(
        "UPDATE jobs SET status = 'queued', payload = ?, payload_sha256 = ?, dispatch_ready_at = ?, updated_at = ? WHERE id = ?",
        [
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
      preservedAttempt: 1,
      nextAttempt: 2,
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

/** 只允许一个终态 Package 与一个已 passed Profession Job，且两者均无活动 lease。 */
function requireJobs(rows) {
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
  if (
    !["blocked", "failed"].includes(packageJob.status) ||
    Number(packageJob.attempt_count) !== 1 ||
    Number(packageJob.max_attempts) < 2 ||
    Number(packageJob.max_attempts) > 10 ||
    !leaseEmpty
  ) {
    throw new Error("PACKAGE_JOB_NOT_RECOVERABLE");
  }
  return { professionJob, packageJob };
}

/** 验证旧 payload 自身、旧 profile 摘要和历史 Job payload 摘要仍精确一致。 */
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
    profile?.outputMediaType !== "application/octet-stream" ||
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

/** Factory 哈希和 npk-package contract 必须仍冻结同一业务 profile；不迁移 Factory。 */
function requireFactoryContract(row, profileId) {
  const config = jsonValue(row.config);
  if (
    config?.schemaVersion !== 3 ||
    sha256LegacyJson(config) !== row.configSha256.toUpperCase() ||
    !Array.isArray(config.allowedJobKinds) ||
    !config.allowedJobKinds.includes("npk-package") ||
    !Array.isArray(config.jobContracts)
  ) {
    throw new Error("FACTORY_INTEGRITY_FAILED");
  }
  const contracts = config.jobContracts.filter(
    (contract) => contract?.kind === "npk-package",
  );
  if (
    contracts.length !== 1 ||
    contracts[0].schemaVersion !== 1 ||
    contracts[0].profileId !== profileId
  ) {
    throw new Error("FACTORY_PACKAGE_CONTRACT_MISMATCH");
  }
}

/** 旧 attempt 与 evidence 只可读取；要求二者精确记录同一白名单错误和终态。 */
function requireRecoverableAttempt(packageJob, attempt, evidence, input) {
  if (!recoverableErrorCodes.has(input.expectedErrorCode)) {
    throw new Error("PACKAGE_ERROR_NOT_RECOVERABLE");
  }
  if (
    attempt.status !== packageJob.status ||
    attempt.error_code !== input.expectedErrorCode ||
    attempt.finished_at === null ||
    evidence.status !== packageJob.status ||
    evidence.error_code !== input.expectedErrorCode ||
    evidence.finished_at === null ||
    evidence.package_profile_sha256.toUpperCase() !==
      input.expectedProfileSha256 ||
    evidence.job_id !== packageJob.id ||
    evidence.worker_id !== attempt.worker_id ||
    evidence.lease_id !== attempt.lease_id ||
    Number(evidence.attempt) !== 1 ||
    [
      evidence.package_artifact_id,
      evidence.package_sha256,
      evidence.package_upload_id,
      evidence.manifest_artifact_id,
      evidence.manifest_sha256,
      evidence.manifest_upload_id,
      evidence.validation_artifact_id,
      evidence.validation_sha256,
      evidence.validation_upload_id,
    ].some((value) => value !== null) ||
    !hasFalseSafety(jsonValue(evidence.safety))
  ) {
    throw new Error("PACKAGE_ATTEMPT_NOT_RECOVERABLE");
  }
}

/** 聚合行不能已有 candidate/manifest，且职业、风格和终态必须与冻结 Job 一致。 */
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

/** 全部 production 必须与 payload 冻结技能集合一一对应且 passed，不重新运行 Profession。 */
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

/** Run 必须与当前旧 Package 同终态，四项不可提升状态均保持 false。 */
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

/** 权威事件明确记录历史保留和 profile 摘要迁移，不记录工具路径或 payload。 */
function profileMigrationEvent(
  runId,
  sequence,
  databaseTime,
  expectedErrorCode,
  oldProfileSha256,
  newProfileSha256,
) {
  return {
    runId,
    sequence,
    level: "warning",
    stage: "queued",
    message: `Package attempt 1 及其 ${expectedErrorCode} 终态证据已保留；工具 profile 从 ${oldProfileSha256} 迁移到 ${newProfileSha256}，已开放 attempt 2。部署保持禁用。`,
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
