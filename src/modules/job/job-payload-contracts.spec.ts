/**
 * @fileoverview 验证多来源 Inventory v2 payload 只携带逻辑来源身份，不接受本机路径或未知字段。
 * @module modules/job/payload-contracts.spec
 * @author AI生成
 * @created 2026-07-27
 * @relatedPlan N/A - 剑魂多官方源资源导入
 *
 * 调用关系：Vitest 直接调用 parseJobPayload，不创建 Run、Job、Worker 或 Inventory。
 * 输入输出：输入为固定 JSON fixture，输出为已解析 payload 或异常；无网络、数据库和文件副作用。
 * 安全边界：本测试只证明 Server 契约拒绝路径和未注册版本，不证明 Worker 注册表或真实 NPK 可用。
 */
import { describe, expect, it } from "vitest";
import { parseJobPayload } from "./job-payload-contracts.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const snapshotId = "22222222-2222-4222-8222-222222222222";

function inventoryPayload(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    profileId: "resource-profile",
    sourceId: "momentaryslash",
    sourceSha256: "A".repeat(64),
    parameters: {
      workflow: "resource-inventory-import-v2",
      mode: "server-mirror",
      projectId,
      snapshotId,
      snapshotEvidence: {
        rootRulesSha256: "B".repeat(64),
        promptTreeSha256: "C".repeat(64),
        toolCatalogSha256: "D".repeat(64),
      },
      deploymentAuthorized: false,
    },
  };
}

describe("parseJobPayload inventory v2", () => {
  it("接受不含本机路径的来源 ID 与预期摘要", () => {
    const payload = inventoryPayload();
    expect(parseJobPayload("inventory", 2, payload)).toEqual(payload);
  });

  it("拒绝调用方附加来源路径", () => {
    expect(() =>
      parseJobPayload("inventory", 2, {
        ...inventoryPayload(),
        sourceRelativePath: "ImagePacks2/source.npk",
      }),
    ).toThrow();
  });

  it("拒绝把 v2 版本用于未注册的 Profession payload", () => {
    expect(() => parseJobPayload("profession", 2, inventoryPayload())).toThrow(
      "JOB_PAYLOAD_CONTRACT_NOT_REGISTERED",
    );
  });
});
