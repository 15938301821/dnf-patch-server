/**
 * @fileoverview 计算 Run 创建请求的服务器幂等指纹；不替代客户端 requestSha256、不查询数据库，也不创建
 * Run、Job 或事件。
 * @module modules/run/fingerprint
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：RunService 在查询/创建 Idempotency-Key 记录前调用本函数；RunRepository 将结果保存到 Run，
 * 后续相同 key 的请求必须以此指纹安全重放或拒绝。
 * 输入输出：输入是已按 createRunSchema 解析的完整 DTO 和可选稳定 ownerUserId；输出是 JCS v1 规范化
 * JSON 的 SHA-256，不返回客户端证据、数据库行或身份凭据。
 * 副作用：纯内存哈希，无数据库、网络、日志、Worker 或模型副作用。
 * 安全边界：完整请求、摘要大小写和 owner 都参与指纹，防止不同用户或不同 Job 语义复用同一个幂等键；
 * 指纹相同不证明 Factory/Guardrail/Worker/Artifact 已验证，Service 仍完成领域校验。
 */
import { sha256JcsV1 } from "../../common/utils/canonical.js";
import type { CreateRunInput } from "./run.contracts.js";

/**
 * 生成覆盖完整、已解析请求和可选 owner 的确定性服务器幂等指纹。
 * @param input 已经由 createRunSchema 解析的完整创建输入。
 * @param ownerUserId 仅由认证后的受控内部调用传入的稳定用户 id；缺失时不会在指纹中伪造匿名 owner。
 * @returns 十六进制 SHA-256，用于同 Project 内 Idempotency-Key 的安全重放比对。
 * @remarks 该值不替代 input.requestSha256，后者仍是业务证据字段；此函数不负责数据库唯一性竞争处理。
 */
export function createRunRequestFingerprint(
  input: CreateRunInput,
  ownerUserId?: string,
): string {
  return sha256JcsV1({
    schemaVersion: 1,
    ...input,
    ...(ownerUserId ? { ownerUserId } : {}),
    requestSha256: input.requestSha256.toUpperCase(),
    policySha256: input.policySha256.toUpperCase(),
  });
}
