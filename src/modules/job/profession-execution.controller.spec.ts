/**
 * @fileoverview 验证 Profession 固定执行 HTTP 边界的 Worker Guard、精确委托与响应脱敏；不覆盖
 * Service 状态机、真实 MySQL 行锁、对象存储或外部模型调用。
 * @module modules/job/profession-execution-controller-spec
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan /memories/session/plan.md - 单技能 Profession Worker 纵向链路
 *
 * 调用关系：Vitest 直接实例化 Controller，并以 mock Service 代替业务编排。测试只证明路由适配层
 * 保留认证元数据、原样传递严格 DTO，并拒绝 Service 意外返回的敏感额外字段。
 */
import { GUARDS_METADATA } from "@nestjs/common/constants.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerTokenGuard } from "../../common/security/worker-token.guard.js";
import type { RequestProfessionSkillExecutionInput } from "./profession-execution.contracts.js";
import { ProfessionExecutionController } from "./profession-execution.controller.js";
import type { ProfessionExecutionService } from "./profession-execution.service.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const input: RequestProfessionSkillExecutionInput = {
  workerId: "22222222-2222-4222-8222-222222222222",
  leaseId: "33333333-3333-4333-8333-333333333333",
  attempt: 2,
  skillId: "44444444-4444-4444-8444-444444444444",
};
const passed = {
  status: "passed" as const,
  engineerPlan: {
    executionId: "55555555-5555-4555-8555-555555555555",
    modelCallId: "66666666-6666-4666-8666-666666666666",
    outputArtifactId: "77777777-7777-4777-8777-777777777777",
    mediaType: "application/json" as const,
    byteLength: 128,
    sha256: "A".repeat(64),
  },
  referenceImage: {
    executionId: "88888888-8888-4888-8888-888888888888",
    modelCallId: "99999999-9999-4999-8999-999999999999",
    imageAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    outputArtifactId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    mediaType: "image/png" as const,
    byteLength: 256,
    sha256: "B".repeat(64),
  },
};

describe("ProfessionExecutionController", () => {
  const executeSkill = vi.fn();
  let controller: ProfessionExecutionController;

  beforeEach(() => {
    vi.resetAllMocks();
    controller = new ProfessionExecutionController({
      executeSkill,
    } as unknown as ProfessionExecutionService);
  });

  it("requires Worker authentication and delegates the exact lease DTO", async () => {
    executeSkill.mockResolvedValue(passed);

    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      ProfessionExecutionController,
    ) as unknown[] | undefined;
    expect(guards).toContain(WorkerTokenGuard);
    await expect(controller.executeSkill(jobId, input)).resolves.toEqual(
      passed,
    );
    expect(executeSkill).toHaveBeenCalledWith(jobId, input);
  });

  it("fails closed when the Service response contains an undeclared field", async () => {
    executeSkill.mockResolvedValue({
      ...passed,
      prompt: "must-not-cross-http-boundary",
    });

    await expect(controller.executeSkill(jobId, input)).rejects.toMatchObject({
      name: "ZodError",
    });
  });
});
