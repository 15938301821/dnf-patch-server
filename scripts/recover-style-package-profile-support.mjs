/**
 * @fileoverview 为 Package profile 恢复脚本提供无数据库副作用的 CLI 校验、JSON 规范化摘要、
 * UTC 时间格式化和稳定错误收敛；不读取环境、不连接数据库、不修改 Run 或 Artifact。
 * @module scripts/operations
 * @author AI生成
 * @created 2026-07-28
 * @relatedPlan N/A - 剑魂多官方 NPK 来源 Package V3 实机恢复
 *
 * 调用关系：recover-style-package-profile.mjs 在事务外解析输入、事务内重算冻结摘要，并在最外层
 * 收敛错误。输入仅为内存中的字符串/JSON，输出为校验后的值或大写 SHA-256；失败时抛出稳定
 * 大写错误码，不接触 payload 之外的本机路径、凭据、对象存储或 Worker。
 */
import { createHash } from "node:crypto";

/** 解析固定四参数及可选 `--apply`；默认模式始终是只读事务预演。 */
export function parseArguments(arguments_) {
  const apply = arguments_.includes("--apply");
  const values = arguments_.filter((value) => value !== "--apply");
  if (values.length !== 4) throw new Error("USAGE_INVALID");
  const [runId, expectedProfileSha256, packagerSha256, validatorSha256] =
    values;
  if (!isUuid(runId)) throw new Error("RUN_ID_INVALID");
  for (const value of [
    expectedProfileSha256,
    packagerSha256,
    validatorSha256,
  ]) {
    if (!isSha256(value)) throw new Error("SHA256_INVALID");
  }
  return {
    runId: runId.toLowerCase(),
    expectedProfileSha256: expectedProfileSha256.toUpperCase(),
    packagerSha256: packagerSha256.toUpperCase(),
    validatorSha256: validatorSha256.toUpperCase(),
    apply,
  };
}

/** DATABASE_URL 只在调用脚本的进程环境读取；禁止空值或默认连接降级。 */
export function requiredDatabaseUrl(value) {
  if (typeof value !== "string" || value.length < 1) {
    throw new Error("DATABASE_URL_REQUIRED");
  }
  return value;
}

/** mysql2 可能按连接配置返回对象或 JSON 文本，这里只做等价解析。 */
export function jsonValue(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

/** 四项声明必须全部是严格 boolean false，缺失、0 或字符串 false 均拒绝。 */
export function hasFalseSafety(value) {
  return (
    value?.deploymentAuthorized === false &&
    value?.deploymentPerformed === false &&
    value?.fullSkillCoverageProven === false &&
    value?.clientCompatibilityProven === false
  );
}

/** 构造脚本输出中的不可提升安全状态。 */
export function falseSafety() {
  return {
    deploymentAuthorized: false,
    deploymentPerformed: false,
    fullSkillCoverageProven: false,
    clientCompatibilityProven: false,
  };
}

/** 数据库 UTC_TIMESTAMP(3) 必须能无损转成 ISO UTC 时间。 */
export function requireDatabaseTime(value) {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(mysqlUtcToIso(value)))
  ) {
    throw new Error("DATABASE_TIME_INVALID");
  }
  return value;
}

/** mysql dateStrings 的 `YYYY-MM-DD HH:mm:ss.SSS` 转协议使用的 UTC ISO 文本。 */
export function mysqlUtcToIso(value) {
  return `${value.replace(" ", "T")}Z`;
}

/** 复现 Server 历史 sha256Json，用于核对既有 Factory 与 Job payload 身份。 */
export function sha256LegacyJson(value) {
  return hashJson(JSON.stringify(sortLegacy(value)));
}

/** 复现 Server sha256JcsV1，用于核对和生成 Package profile 身份。 */
export function sha256JcsV1(value) {
  return hashJson(encodeJcs(value));
}

/** 只向 stderr 暴露有界稳定错误码，不泄漏 SQL、路径、payload 或数据库异常正文。 */
export function stableErrorCode(error) {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  return /^[A-Z][A-Z0-9_]{2,100}$/u.test(message)
    ? message
    : "STYLE_PACKAGE_PROFILE_RECOVERY_FAILED";
}

function hashJson(value) {
  return createHash("sha256").update(value, "utf8").digest("hex").toUpperCase();
}

function sortLegacy(value) {
  if (Array.isArray(value)) return value.map(sortLegacy);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortLegacy(child)]),
    );
  }
  return value;
}

function encodeJcs(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(encodeJcs).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encodeJcs(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("JSON_CANONICALIZATION_FAILED");
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function isSha256(value) {
  return /^[A-F0-9]{64}$/iu.test(value);
}
