/**
 * @fileoverview 验证 Profession 模型桥接前的纯租约和冻结上下文门禁；不连接 MySQL、不调用模型、
 * 不访问对象存储，也不证明真实 Worker 集成。
 * @module modules/job/profession-execution-context-spec
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan /memories/session/plan.md - 单技能 Profession Worker 纵向链路
 *
 * 调用关系：Vitest 直接调用纯解析器，fixture 代替 Repository 锁定行和数据库时间。测试保护旧 attempt、
 * 非 profession Job、篡改 payload 与未冻结技能不能触发后续模型副作用；真实事务竞态仍需 Repository 测试证明。
 */
import { describe, expect, it } from "vitest";
import { sha256JcsV1, sha256Json } from "../../common/utils/canonical.js";
import {
  resolveProfessionExecutionContext,
  type ProfessionExecutionJobState,
} from "./profession-execution-context.js";
import type { RequestProfessionSkillExecutionInput } from "./profession-execution.contracts.js";
import { createStyleSkillProductionJobPayload } from "./style-skill-production.contracts.js";
import type { StyleBuildContext } from "../profession/profession.contracts.js";

const workerId = "11111111-1111-4111-8111-111111111111";
const leaseId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const professionId = "44444444-4444-4444-8444-444444444444";
const styleId = "55555555-5555-4555-8555-555555555555";
const skillId = "66666666-6666-4666-8666-666666666666";
const now = new Date("2026-07-24T00:00:00.000Z");

describe("resolveProfessionExecutionContext", () => {
  it("returns the frozen selected skill for the exact current lease", () => {
    const result = resolveProfessionExecutionContext(job(), input(), now);

    expect(result).toMatchObject({
      status: "accepted",
      context: {
        runId,
        profileId: "aseprite-production-v1",
        professionId,
        styleId,
        skill: { skillId },
      },
    });
  });

  it.each([
    ["wrong worker", { workerId: "77777777-7777-4777-8777-777777777777" }],
    ["wrong lease", { leaseId: "88888888-8888-4888-8888-888888888888" }],
    ["old attempt", { attempt: 1 }],
  ])("rejects %s before exposing frozen context", (_label, override) => {
    expect(
      resolveProfessionExecutionContext(job(), input(override), now),
    ).toEqual({ status: "lease-mismatch" });
  });

  it("rejects an expired lease using database time", () => {
    expect(
      resolveProfessionExecutionContext(
        job({ leaseExpiresAt: now }),
        input(),
        now,
      ),
    ).toEqual({ status: "lease-mismatch" });
  });

  it("rejects a non-profession Job even when the lease matches", () => {
    expect(
      resolveProfessionExecutionContext(
        job({ kind: "inventory" }),
        input(),
        now,
      ),
    ).toEqual({ status: "job-kind-mismatch" });
  });

  it("rejects a payload whose persisted SHA-256 no longer matches", () => {
    expect(
      resolveProfessionExecutionContext(
        job({ payloadSha256: "F".repeat(64) }),
        input(),
        now,
      ),
    ).toEqual({ status: "job-integrity-failed" });
  });

  it("rejects a skill that is absent from the frozen selected set", () => {
    expect(
      resolveProfessionExecutionContext(
        job(),
        input({ skillId: "99999999-9999-4999-8999-999999999999" }),
        now,
      ),
    ).toEqual({ status: "skill-not-found" });
  });
});

function input(
  override: Partial<RequestProfessionSkillExecutionInput> = {},
): RequestProfessionSkillExecutionInput {
  return { workerId, leaseId, attempt: 2, skillId, ...override };
}

function job(
  override: Partial<ProfessionExecutionJobState> = {},
): ProfessionExecutionJobState {
  const payload = createStyleSkillProductionJobPayload(
    buildContext(),
    "aseprite-production-v1",
  );
  return {
    runId,
    kind: "profession",
    status: "leased",
    leaseOwnerId: workerId,
    leaseId,
    leaseExpiresAt: new Date("2026-07-24T00:01:00.000Z"),
    attemptCount: 2,
    payload,
    payloadSha256: sha256Json(payload),
    ...override,
  };
}

function buildContext(): StyleBuildContext {
  const professionPrompt = {
    schemaVersion: 1 as const,
    stableSemantics: "保留技能身份",
    commonPrompt: "保持源帧轮廓",
    sourceConstraints: "只处理已冻结来源",
    stageAcceptance: "逐帧满足来源约束",
  };
  return {
    profession: {
      id: professionId,
      name: "测试职业",
      slug: "test-profession",
      canonicalName: "测试职业",
      styleCount: 1,
      publishStatus: "private",
      workflowProjectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      catalogSnapshotId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      updatedAt: "2026-07-24T00:00:00.000Z",
    },
    style: {
      id: styleId,
      professionId,
      name: "测试风格",
      description: "单技能模型桥接 fixture",
      themeDefinition: {
        schemaVersion: 1,
        goal: "生成受来源约束的候选特效",
        baseStyle: "high contrast pixel effect",
        colorAnchors: [{ name: "主色", value: "#123456" }],
        materialRules: "保持清晰边缘",
        particleRules: "粒子遵循源帧节奏",
        layeringRules: "不改变层级语义",
        constraints: "不得新增人物或武器",
        acceptanceCriteria: "轮廓和时间轴可辨识",
        exclusions: "不修改命中范围",
      },
      selectedSkillIds: [skillId],
      skillPrompts: [
        {
          skillId,
          themePrompt: "暗蓝像素剑气",
          changes: "只调整材质和颜色",
          acceptanceCriteria: "保持源动作节奏",
          exclusions: "不增加人物内容",
        },
      ],
      publishStatus: "private",
      updatedAt: "2026-07-24T00:00:00.000Z",
    },
    skills: [
      {
        id: skillId,
        professionId,
        displayName: "测试技能",
        promptStatus: "reviewed",
        mappingStatus: "verified",
        executionStatus: "build-ready",
        sourceRunId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        sourceInventoryId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        sourceFrameManifestArtifactId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        sourceEntries: [
          {
            sourceInventoryEntryId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            sourceMetadataSha256: "A".repeat(64),
          },
        ],
        professionPrompt,
        professionPromptSha256: sha256JcsV1(professionPrompt),
      },
    ],
    missingProfessionPromptSkillIds: [],
  };
}
