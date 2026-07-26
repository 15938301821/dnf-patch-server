/**
 * @fileoverview 对已有本地 Profession Run 执行只读持久化核验，并对私有对象存储执行一个
 * 可清理的随机对象往返诊断；不创建 Run/Job、不调用模型或 Worker、不读取游戏目录，也不部署补丁。
 * @module scripts/probe-profession-engineer-persistence
 * @author AI生成
 * @created 2026-07-26
 * @relatedPlan N/A - 用户直接要求继续整理本地诊断脚本
 *
 * 调用关系：维护者通过 `npm run probe:profession-persistence -- <jobId> [runId]` 显式运行；
 * 本脚本只读 MySQL 权威行，再调用 profession-persistence-probe-support.cjs 核对私有 Artifact。
 * 输入：现有 Profession Job UUID、可选 Run UUID，以及与当前本地服务相同的数据库/对象存储环境。
 * 输出：脱敏 JSON 摘要和进程退出码；不输出数据库 URL、凭据、对象键、模型正文或绝对路径。
 * 副作用：数据库只读；对象存储往返诊断会创建一个随机 diagnostics 对象并在 finally 删除。
 * 安全边界：Job/Run 必须匹配，Artifact 必须使用数据库 storage_key/长度/SHA-256，任何对象证据、
 * ZIP manifest 或清理失败都会令结果失败；结果不证明客户端兼容、全技能覆盖或部署可用。
 */
const mysql = require("mysql2/promise");
const {
  createStorageClient,
  inspectArtifactObject,
  inspectPackageInput,
  parseProbeArguments,
  parseProbeEnvironment,
  probeObjectStorageRoundTrip,
  summarizeFactoryConfig,
  toStableErrorCode,
} = require("./profession-persistence-probe-support.cjs");

const usage =
  "npm run probe:profession-persistence -- <professionJobId> [runId]";

async function main() {
  const { jobId, runId } = parseProbeArguments(process.argv.slice(2));
  const environment = parseProbeEnvironment(process.env);
  let database;
  let storage;
  try {
    database = await mysql.createConnection({
      uri: environment.databaseUrl,
      dateStrings: true,
    });
    storage = createStorageClient(environment.storage);

    // 步骤 1：先确认 Job 存在及可选 Run 归属；不匹配时不得读取任何私有对象或写诊断对象。
    const [jobIdentityRows] = await database.execute(
      "select run_id as runId, kind, status, attempt_count as attemptCount from jobs where id = ? limit 1",
      [jobId],
    );
    const job = jobIdentityRows[0];
    const actualRunId = job?.runId;
    if (typeof actualRunId !== "string") throw new Error("JOB_NOT_FOUND");
    if (job.kind !== "profession") throw new Error("PROFESSION_JOB_REQUIRED");
    if (!Number.isInteger(job.attemptCount) || job.attemptCount <= 0) {
      throw new Error("PROFESSION_JOB_NOT_ATTEMPTED");
    }
    if (runId !== undefined && actualRunId !== runId) {
      throw new Error("JOB_RUN_MISMATCH");
    }

    // 步骤 2：从 Artifact 表取得权威 storageKey，避免按阶段或文件名重新猜对象位置。
    const [rows] = await database.execute(
      "select e.id, e.attempt, e.stage, e.status, e.model_call_id as modelCallId, e.output_sha256 as outputSha256, e.output_byte_length as outputByteLength, e.output_artifact_id as outputArtifactId, e.error_code as errorCode, a.storage_key as storageKey, a.media_type as artifactMediaType, a.byte_length as artifactByteLength, a.sha256 as artifactSha256 from profession_skill_model_executions e left join artifacts a on a.run_id = e.run_id and a.id = e.output_artifact_id where e.job_id = ? order by e.attempt, e.stage",
      [jobId],
    );
    if (rows.length === 0) throw new Error("PROFESSION_EXECUTIONS_NOT_FOUND");
    const executions = [];
    for (const row of rows) {
      const artifact = toArtifactMetadata(row);
      const objectEvidence =
        row.outputArtifactId === null
          ? { checked: false, passed: row.status !== "passed" }
          : await inspectArtifactObject(storage, environment.storage, artifact);
      const metadataMatches =
        row.outputArtifactId === null ||
        (artifact !== undefined &&
          row.outputByteLength === artifact.byteLength &&
          row.outputSha256 === artifact.sha256);
      const expectedMediaTypeMatches =
        artifact !== undefined &&
        ((row.stage === "engineer-plan-v1" &&
          artifact.mediaType === "application/json") ||
          (row.stage === "reference-image-v1" &&
            artifact.mediaType === "image/png"));
      executions.push({
        executionId: row.id,
        attempt: row.attempt,
        stage: row.stage,
        status: row.status,
        hasModelCall: row.modelCallId !== null,
        outputByteLength: row.outputByteLength,
        hasOutputSha256: row.outputSha256 !== null,
        hasArtifact: row.outputArtifactId !== null,
        metadataMatches,
        expectedMediaTypeMatches,
        errorCode: row.errorCode,
        objectEvidence,
      });
    }

    // 步骤 3：提供 Run 时读取冻结契约与 passed 技能 validation ZIP；各对象串行处理以限制内存峰值。
    const runInspection =
      runId === undefined
        ? undefined
        : await inspectRun(database, storage, environment.storage, runId);

    // 步骤 4：最后执行随机对象往返；无论成功失败，支持模块都必须尝试删除诊断对象。
    const roundTrip = await probeObjectStorageRoundTrip(
      storage,
      environment.storage,
    );
    const currentAttempt = evaluateCurrentAttempt(executions, job.attemptCount);
    const packageEvidencePassed =
      runInspection === undefined ||
      (runInspection.packageInputManifests.length > 0 &&
        runInspection.packageInputManifests.every((item) => item.passed));
    return {
      schemaVersion: 1,
      kind: "dnf-profession-persistence-probe-v1",
      status:
        currentAttempt.passed && packageEvidencePassed && roundTrip.passed
          ? "passed"
          : "failed",
      job: {
        status: job.status,
        attemptCount: job.attemptCount,
        currentAttemptEvidencePassed: currentAttempt.passed,
        currentAttemptErrorCode: currentAttempt.errorCode,
      },
      executions,
      roundTrip,
      ...(runInspection ?? {}),
    };
  } finally {
    if (database) await database.end();
    storage?.destroy();
  }
}

/**
 * 只判定 Job 当前 attempt 的两个固定模型阶段；历史失败 attempt 保留在输出中但不覆盖当前成功。
 * @param {object[]} executions 全部 attempt 的脱敏执行摘要。
 * @param {number} attemptCount jobs 表当前权威 attempt_count。
 * @returns {{ passed: boolean, errorCode: string | null }} 当前 attempt 是否形成完整持久化证据。
 */
function evaluateCurrentAttempt(executions, attemptCount) {
  const current = executions.filter(
    (execution) => execution.attempt === attemptCount,
  );
  const requiredStages = new Set(["engineer-plan-v1", "reference-image-v1"]);
  if (
    current.length !== requiredStages.size ||
    new Set(current.map((execution) => execution.stage)).size !==
      requiredStages.size ||
    current.some((execution) => !requiredStages.has(execution.stage))
  ) {
    return {
      passed: false,
      errorCode: "CURRENT_ATTEMPT_STAGE_CARDINALITY_INVALID",
    };
  }
  const passed = current.every(
    (execution) =>
      execution.status === "passed" &&
      execution.hasModelCall &&
      execution.hasArtifact &&
      execution.metadataMatches &&
      execution.expectedMediaTypeMatches &&
      execution.objectEvidence.passed,
  );
  return {
    passed,
    errorCode: passed ? null : "CURRENT_ATTEMPT_EVIDENCE_INVALID",
  };
}

async function inspectRun(database, storage, storageConfig, runId) {
  const [jobRows] = await database.execute(
    "select kind, status, attempt_count as attemptCount, dispatch_ready_at is not null as dispatchReady from jobs where run_id = ? order by created_at",
    [runId],
  );
  const [factoryRows] = await database.execute(
    "select f.config from runs r inner join projects p on p.id = r.project_id inner join factories f on f.id = p.factory_id where r.id = ? limit 1",
    [runId],
  );
  if (factoryRows.length !== 1) throw new Error("RUN_NOT_FOUND");
  const factory = summarizeFactoryConfig(factoryRows[0].config);
  const [inputRows] = await database.execute(
    "select p.skill_id as skillId, a.storage_key as storageKey, a.media_type as mediaType, a.byte_length as byteLength, a.sha256 from style_skill_productions p inner join artifacts a on a.run_id = p.run_id and a.id = p.validation_artifact_id where p.run_id = ? and p.status = 'passed' order by p.created_at",
    [runId],
  );
  const packageInputManifests = [];
  for (const input of inputRows) {
    packageInputManifests.push(
      await inspectPackageInput(storage, storageConfig, input),
    );
  }
  return {
    runFacts: {
      jobs: jobRows.map((job) => ({
        kind: job.kind,
        status: job.status,
        attemptCount: job.attemptCount,
        dispatchReady: Boolean(job.dispatchReady),
      })),
      factorySchemaVersion: factory.schemaVersion,
      contracts: factory.contracts,
    },
    packageInputManifests,
  };
}

function toArtifactMetadata(row) {
  if (
    typeof row.storageKey !== "string" ||
    typeof row.artifactMediaType !== "string" ||
    typeof row.artifactByteLength !== "number" ||
    typeof row.artifactSha256 !== "string"
  ) {
    return undefined;
  }
  return {
    storageKey: row.storageKey,
    mediaType: row.artifactMediaType,
    byteLength: row.artifactByteLength,
    sha256: row.artifactSha256,
  };
}

if (require.main === module) {
  if (process.argv.slice(2).length === 1 && process.argv[2] === "--help") {
    console.log(usage);
  } else {
    main()
      .then((result) => {
        console.log(JSON.stringify(result, null, 2));
        if (result.status !== "passed") process.exitCode = 1;
      })
      .catch((error) => {
        const knownCodes = new Set([
          "JOB_NOT_FOUND",
          "PROFESSION_JOB_REQUIRED",
          "PROFESSION_JOB_NOT_ATTEMPTED",
          "JOB_RUN_MISMATCH",
          "PROFESSION_EXECUTIONS_NOT_FOUND",
          "RUN_NOT_FOUND",
        ]);
        const code = knownCodes.has(error?.message)
          ? error.message
          : toStableErrorCode(error);
        console.error(code);
        process.exitCode = 1;
      });
  }
}

module.exports = { evaluateCurrentAttempt };
