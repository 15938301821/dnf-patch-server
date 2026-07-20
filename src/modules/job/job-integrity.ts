/**
 * @fileoverview 校验数据库中的 Job 载荷与冻结 Factory 契约，不执行本机工具或文件操作。
 * @module job
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan JOB-001-SHARED-FX
 */
import { sha256Schema } from "../../common/contracts/index.js";
import { sha256Json } from "../../common/utils/canonical.js";
import {
  factoryConfigSchema,
  type FactoryConfig,
} from "../factory/factory.contracts.js";
import {
  allowedJobKindSchema,
  type AllowedJobKind,
} from "../guardrail/guardrail.contracts.js";
import { parseJobPayload } from "./job-payload-contracts.js";

export interface PersistedJobIntegrityInput {
  kind: unknown;
  payload: unknown;
  payloadSha256: unknown;
  factoryConfig: unknown;
  factoryConfigSha256: unknown;
}

/**
 * 只有数据库中的载荷、其哈希和 Factory 冻结契约全部一致时才允许下发 Worker。
 * @param input 数据库 JSON/字符串列，均按 unknown 处理。
 * @returns 数据完整且符合 Factory v2 声明式契约时返回 true。
 */
export function validatePersistedJobIntegrity(
  input: PersistedJobIntegrityInput,
): boolean {
  const kind = allowedJobKindSchema.safeParse(input.kind);
  const payloadHash = sha256Schema.safeParse(input.payloadSha256);
  const factoryHash = sha256Schema.safeParse(input.factoryConfigSha256);
  const config = factoryConfigSchema.safeParse(input.factoryConfig);
  if (!kind.success || !payloadHash.success || !factoryHash.success) {
    return false;
  }
  if (!config.success || config.data.schemaVersion !== 2) return false;
  if (!hasValidFactoryHash(config.data, factoryHash.data)) return false;

  const contract = config.data.jobContracts.find(
    (candidate) => candidate.kind === kind.data,
  );
  if (
    !contract ||
    !config.data.allowedJobKinds.includes(kind.data) ||
    !hasValidPayload(
      input.payload,
      kind.data,
      contract.schemaVersion,
      config.data.profileId,
    )
  ) {
    return false;
  }
  try {
    return sha256Json(input.payload) === payloadHash.data.toUpperCase();
  } catch {
    return false;
  }
}

function hasValidFactoryHash(
  config: Extract<FactoryConfig, { schemaVersion: 2 }>,
  persistedHash: string,
): boolean {
  try {
    return sha256Json(config) === persistedHash.toUpperCase();
  } catch {
    return false;
  }
}

function hasValidPayload(
  payload: unknown,
  kind: AllowedJobKind,
  schemaVersion: number,
  profileId: string,
): boolean {
  try {
    return (
      parseJobPayload(kind, schemaVersion, payload).profileId === profileId
    );
  } catch {
    return false;
  }
}
