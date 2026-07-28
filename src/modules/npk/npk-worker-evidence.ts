/**
 * @fileoverview 校验 Worker Inventory 回填使用的来源绑定与 finalized Artifact provenance。
 * @module modules/npk/worker-evidence
 * @author AI生成
 * @created 2026-07-27
 * @relatedPlan N/A - 剑魂多官方源 Inventory
 *
 * 调用关系：NpkRepository 在持有数据库 Job/Run/上传会话行锁后调用本模块，再决定是否写入
 * Inventory。本模块输入是已从数据库读出的 payload/provenance 或已由 Controller 解析的 DTO，
 * 输出仅为来源绑定、类型收窄或布尔判定。
 * 副作用：纯内存解析与比较，不访问数据库、对象存储、官方 NPK 或本机路径。
 * 失败路径：payload 版本、来源 ID/摘要、Artifact 角色或媒体类型不一致时返回 undefined/false，
 * Repository 必须失败关闭；本模块不会把异常输入修正为可信证据。
 * 安全边界：v2 sourceId 必须同时绑定冻结 Job、两个 Artifact、Worker DTO 与最终数据库行；
 * 任意同 Run Artifact 或仅摘要相同的其他来源都不能冒充当前 Job 证据。
 */
import type {
  CreateInventoryInput,
  CreateWorkerInventoryInput,
} from "./npk.contracts.js";
import { parseJobPayload } from "../job/job-payload-contracts.js";

/** Worker Job 冻结的逻辑来源；v1 没有 sourceId，v2 同时固定 ID 与摘要。 */
export interface InventorySourceBinding {
  sourceId?: string;
  sourceSha256?: string;
}

/**
 * 核对 finalized Artifact 的固定角色、源身份与媒体类型。
 * @param artifact 当前 lease/attempt 查询到的 Artifact 元数据；undefined 表示指定 ID 不存在。
 * @param logicalName 当前证据角色要求的固定逻辑文件名。
 * @param kind provenance 中要求的固定证据类型。
 * @param sourceSha256 Worker DTO 已声明且还会与 Job payload 比较的官方源摘要。
 * @param sourceId 从冻结 Job 恢复的逻辑来源 ID；v1 必须保持 undefined。
 * @returns 仅全部字段精确绑定时为 true；不读取 Artifact 正文，也不证明资源映射正确。
 */
export function hasExpectedArtifactEvidence(
  artifact:
    | {
        logicalName: string;
        mediaType: string;
        provenance: Record<string, unknown>;
      }
    | undefined,
  logicalName: string,
  kind: string,
  sourceSha256: string,
  sourceId: string | undefined,
): boolean {
  return (
    artifact?.logicalName === logicalName &&
    artifact.mediaType === "application/json" &&
    artifact.provenance.schemaVersion === 1 &&
    artifact.provenance.kind === kind &&
    artifact.provenance.sourceId === sourceId &&
    typeof artifact.provenance.sourceSha256 === "string" &&
    artifact.provenance.sourceSha256.toUpperCase() ===
      sourceSha256.toUpperCase()
  );
}

/**
 * 从数据库中的冻结 Inventory Job payload 恢复逻辑来源绑定。
 * @param payload jobs.payload 的不可信 JSON 值，必须重新经过公共版本化契约解析。
 * @returns v1 返回空绑定；v2 返回 sourceId/大写摘要；非法或未知版本返回 undefined。
 */
export function readInventorySourceBinding(
  payload: unknown,
): InventorySourceBinding | undefined {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("schemaVersion" in payload) ||
    (payload.schemaVersion !== 1 && payload.schemaVersion !== 2)
  ) {
    return undefined;
  }
  try {
    const parsed = parseJobPayload("inventory", payload.schemaVersion, payload);
    if (parsed.schemaVersion === 1) return {};
    if (!("sourceId" in parsed) || !("sourceSha256" in parsed)) {
      return undefined;
    }
    return {
      sourceId: parsed.sourceId,
      sourceSha256: parsed.sourceSha256.toUpperCase(),
    };
  } catch {
    return undefined;
  }
}

/** 区分普通创建 DTO 与强制携带 sourceId、源帧清单及 Worker 租约字段的回填 DTO。 */
export function hasFrameManifest(
  input: CreateInventoryInput | CreateWorkerInventoryInput,
): input is CreateWorkerInventoryInput {
  return "sourceFrameManifestArtifactId" in input;
}
