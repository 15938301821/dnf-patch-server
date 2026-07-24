/**
 * @fileoverview 验证 Profession 技能源 Service 对 Repository 有限状态的稳定 HTTP 业务映射；
 * 不连接 MySQL、不经过 Worker Guard，也不执行源扫描或对象下载。
 * @module modules/job/profession-source-context-service-spec
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：Vitest 直接实例化 Service，以 Repository mock 替代事务边界。测试只证明成功透传和
 * 稳定错误码/HTTP 类别，不证明真实租约、数据库行锁或证据联查。
 */
import { ConflictException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestProfessionSkillExecutionInput } from "./profession-execution.contracts.js";
import type { ProfessionSkillSourceContextView } from "./profession-source-context.contracts.js";
import type { ProfessionSourceContextRepository } from "./profession-source-context.repository.js";
import { ProfessionSourceContextService } from "./profession-source-context.service.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const input: RequestProfessionSkillExecutionInput = {
  workerId: "22222222-2222-4222-8222-222222222222",
  leaseId: "33333333-3333-4333-8333-333333333333",
  attempt: 2,
  skillId: "44444444-4444-4444-8444-444444444444",
};
const context: ProfessionSkillSourceContextView = {
  schemaVersion: 1,
  skillId: input.skillId,
  source: {
    runId: "55555555-5555-4555-8555-555555555555",
    inventoryId: "66666666-6666-4666-8666-666666666666",
    byteLength: 100,
    sha256: "A".repeat(64),
  },
  frameManifest: {
    artifactId: "77777777-7777-4777-8777-777777777777",
    mediaType: "application/json",
    byteLength: 200,
    sha256: "B".repeat(64),
    toolSha256: "C".repeat(64),
  },
  entries: [
    {
      sourceInventoryEntryId: "88888888-8888-4888-8888-888888888888",
      internalPath: "sprite/effect/skill.img",
      imgVersion: 5,
      frameCount: 12,
      metadataSha256: "D".repeat(64),
    },
  ],
};

describe("ProfessionSourceContextService", () => {
  const resolveSkillSourceContext = vi.fn();
  let service: ProfessionSourceContextService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new ProfessionSourceContextService({
      resolveSkillSourceContext,
    } as unknown as ProfessionSourceContextRepository);
  });

  it("returns the accepted frozen source context without adding fields", async () => {
    resolveSkillSourceContext.mockResolvedValue({
      status: "accepted",
      context,
    });

    await expect(service.getSkillSourceContext(jobId, input)).resolves.toBe(
      context,
    );
    expect(resolveSkillSourceContext).toHaveBeenCalledWith(jobId, input);
  });

  it.each([
    ["lease-mismatch", ConflictException, "JOB_LEASE_MISMATCH"],
    ["job-kind-mismatch", ConflictException, "PATCH_TASK_JOB_KIND_REQUIRED"],
    [
      "job-integrity-failed",
      ConflictException,
      "PROFESSION_JOB_INTEGRITY_FAILED",
    ],
    ["skill-not-found", NotFoundException, "PROFESSION_JOB_SKILL_NOT_FOUND"],
    [
      "source-evidence-mismatch",
      ConflictException,
      "PROFESSION_SOURCE_EVIDENCE_MISMATCH",
    ],
  ] as const)(
    "maps %s to a stable exception without database detail",
    async (status, ExceptionType, code) => {
      resolveSkillSourceContext.mockResolvedValue({ status });

      try {
        await service.getSkillSourceContext(jobId, input);
        throw new Error("TEST_EXPECTED_EXCEPTION");
      } catch (error) {
        expect(error).toBeInstanceOf(ExceptionType);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code,
        });
      }
    },
  );
});
