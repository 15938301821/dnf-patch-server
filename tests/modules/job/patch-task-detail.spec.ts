/**
 * @fileoverview 验证制作任务详情的阶段保守映射与模型吞吐公式；不连接 MySQL、模型或对象存储。
 * @module modules/job/patch-task-detail-spec
 * @author AI生成
 * @created 2026-07-28
 * @relatedPlan /memories/session/plan.md - 制作任务详情与模型吞吐监控
 *
 * 测试以有限数据库投影替代 Repository 查询，只证明纯映射；用户所有权、真实 CHECK 与外键仍需
 * Repository 测试和隔离 MySQL 验证。缺失 usage 与历史失败必须保留不确定性，防止页面伪造指标。
 */
import { describe, expect, it } from "vitest";
import {
  buildPatchTaskDetail,
  type PatchTaskDetailBase,
  type PatchTaskDetailExecutionRecord,
} from "../../../src/modules/job/patch-task-detail.js";
import {
  aggregateModelThroughput,
  type PatchTaskDetailModelCallRecord,
} from "../../../src/modules/job/patch-task-model-throughput.js";

describe("buildPatchTaskDetail", () => {
  it("按当前 attempt 映射模型、适配与验证阶段", () => {
    const detail = buildPatchTaskDetail({
      task: task("running", "queued"),
      skills: [
        {
          skillId: "11111111-1111-4111-8111-111111111111",
          displayName: "幻影剑舞",
          ordinal: 0,
          status: "validating",
          attempt: 2,
          errorCode: null,
        },
      ],
      executions: [
        execution("engineer-plan-v1", "passed", 2, "application/json"),
        execution("reference-image-v1", "passed", 2, "image/png"),
        execution("reference-image-v1", "failed", 1, null),
      ],
      modelCalls: [],
    });

    expect(detail).toMatchObject({
      currentStage: "skill-production",
      totalSkills: 1,
      passedSkills: 0,
      skills: [
        {
          status: "running",
          referenceImageAvailable: true,
          stages: [
            { key: "engineer-plan", status: "passed" },
            { key: "reference-image", status: "passed" },
            { key: "aseprite-adaptation", status: "passed" },
            { key: "runtime-validation", status: "running" },
          ],
        },
      ],
    });
  });

  it("识别当前 V3 模型阶段并开放参考图预览", () => {
    const detail = buildPatchTaskDetail({
      task: task("passed", "passed"),
      skills: [
        {
          skillId: "11111111-1111-4111-8111-111111111111",
          displayName: "幻影剑舞",
          ordinal: 0,
          status: "passed",
          attempt: 1,
          errorCode: null,
        },
      ],
      executions: [
        execution("engineer-plan-v3", "passed", 1, "application/json"),
        execution("reference-image-v3", "passed", 1, "image/png"),
      ],
      modelCalls: [],
    });

    expect(detail.skills[0]).toMatchObject({
      status: "passed",
      referenceImageAvailable: true,
      stages: [
        { key: "engineer-plan", status: "passed" },
        { key: "reference-image", status: "passed" },
        { key: "aseprite-adaptation", status: "passed" },
        { key: "runtime-validation", status: "passed" },
      ],
    });
  });

  it("仍按历史 V2 模型阶段开放只读参考图预览", () => {
    const detail = buildPatchTaskDetail({
      task: task("passed", "passed"),
      skills: [
        {
          skillId: "11111111-1111-4111-8111-111111111111",
          displayName: "幻影剑舞",
          ordinal: 0,
          status: "passed",
          attempt: 1,
          errorCode: null,
        },
      ],
      executions: [
        execution("engineer-plan-v2", "passed", 1, "application/json"),
        execution("reference-image-v2", "passed", 1, "image/png"),
      ],
      modelCalls: [],
    });

    expect(detail.skills[0]).toMatchObject({
      referenceImageAvailable: true,
      stages: [
        { key: "engineer-plan", status: "passed" },
        { key: "reference-image", status: "passed" },
        { key: "aseprite-adaptation", status: "passed" },
        { key: "runtime-validation", status: "passed" },
      ],
    });
  });

  it("历史失败缺少子步骤证据时保留 unknown", () => {
    const detail = buildPatchTaskDetail({
      task: task("failed", "queued"),
      skills: [
        {
          skillId: "11111111-1111-4111-8111-111111111111",
          displayName: "幻影剑舞",
          ordinal: 0,
          status: "failed",
          attempt: 2,
          errorCode: "PROFESSION_ASEPRITE_TOOL_TIMEOUT",
        },
      ],
      executions: [
        execution("engineer-plan-v1", "passed", 2, "application/json"),
        execution("reference-image-v1", "passed", 2, "image/png"),
      ],
      modelCalls: [],
    });

    expect(detail.skills[0]).toMatchObject({
      status: "failed",
      errorCode: "PROFESSION_ASEPRITE_TOOL_TIMEOUT",
      stages: [
        { status: "passed" },
        { status: "passed" },
        { status: "unknown" },
        { status: "unknown" },
      ],
    });
  });
});

describe("aggregateModelThroughput", () => {
  it("只用完整 usage 和正耗时计算加权吞吐并单独报告覆盖率", () => {
    const result = aggregateModelThroughput([
      call("passed", true, 100, 40, 140, 1_000, 0),
      call("passed", true, 200, 60, 260, 2_000, 1),
      call("failed", true, null, null, null, 500, 2),
      call("blocked", false, null, null, null, null, 3),
    ]);

    expect(result).toMatchObject({
      totalCalls: 4,
      egressCalls: 3,
      runningCalls: 0,
      measuredCalls: 2,
      successRate: 66.7,
      inputTokens: 300,
      outputTokens: 100,
      totalTokens: 400,
      averageOutputTokensPerSecond: 33.3,
      averageProviderLatencyMs: 1167,
    });
    expect(result.recentCalls[2]).toMatchObject({
      inputTokens: null,
      outputTokensPerSecond: null,
    });
  });

  it("无可靠 usage 时返回未计量而不是零", () => {
    const result = aggregateModelThroughput([
      call("running", true, null, null, null, null, 0),
    ]);

    expect(result).toMatchObject({
      measuredCalls: 0,
      successRate: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      averageOutputTokensPerSecond: null,
    });
  });
});

function task(runStatus: string, packageStatus: string): PatchTaskDetailBase {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    professionName: "剑魂",
    styleName: "暗蓝幻影",
    runStatus,
    packageStatus,
    createdAt: new Date("2026-07-28T00:00:00.000Z"),
    updatedAt: new Date("2026-07-28T00:02:00.000Z"),
    finishedAt: null,
    artifactName: null,
    packageArtifactId: null,
  };
}

function execution(
  stage: string,
  status: string,
  attempt: number,
  outputMediaType: string | null,
): PatchTaskDetailExecutionRecord {
  return {
    skillId: "11111111-1111-4111-8111-111111111111",
    attempt,
    stage,
    status,
    outputArtifactId: outputMediaType ? crypto.randomUUID() : null,
    outputMediaType,
  };
}

function call(
  status: string,
  modelEgressPerformed: boolean,
  inputTokens: number | null,
  outputTokens: number | null,
  totalTokens: number | null,
  providerLatencyMs: number | null,
  minute: number,
): PatchTaskDetailModelCallRecord {
  return {
    id: crypto.randomUUID(),
    role: minute % 2 === 0 ? "engineer" : "artist",
    model: minute % 2 === 0 ? "text-model" : "image-model",
    status,
    modelEgressPerformed,
    inputTokens,
    outputTokens,
    totalTokens,
    providerLatencyMs,
    createdAt: new Date(
      `2026-07-28T00:${String(minute).padStart(2, "0")}:00.000Z`,
    ),
    finishedAt:
      status === "running" ? null : new Date("2026-07-28T00:10:00.000Z"),
  };
}
