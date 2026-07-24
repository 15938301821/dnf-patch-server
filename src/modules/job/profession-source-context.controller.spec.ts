/**
 * @fileoverview 验证 Profession 冻结技能源 HTTP 边界的 Worker Guard、精确委托和响应脱敏；
 * 不覆盖 Service 事务、真实 MySQL、对象存储或 Worker 本机源 profile。
 * @module modules/job/profession-source-context-controller-spec
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：Vitest 直接实例化 Controller，以 Service mock 替代业务层。测试证明 Guard 元数据存在、
 * 四字段 DTO 原样传递，且 object key/本机路径等额外字段不能越过严格响应 schema。
 */
import { GUARDS_METADATA } from "@nestjs/common/constants.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerTokenGuard } from "../../common/security/worker-token.guard.js";
import type { RequestProfessionSkillExecutionInput } from "./profession-execution.contracts.js";
import { ProfessionSourceContextController } from "./profession-source-context.controller.js";
import type { ProfessionSourceContextService } from "./profession-source-context.service.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const input: RequestProfessionSkillExecutionInput = {
  workerId: "22222222-2222-4222-8222-222222222222",
  leaseId: "33333333-3333-4333-8333-333333333333",
  attempt: 2,
  skillId: "44444444-4444-4444-8444-444444444444",
};
const context = {
  schemaVersion: 1 as const,
  skillId: input.skillId,
  source: {
    runId: "55555555-5555-4555-8555-555555555555",
    inventoryId: "66666666-6666-4666-8666-666666666666",
    byteLength: 100,
    sha256: "A".repeat(64),
  },
  frameManifest: {
    artifactId: "77777777-7777-4777-8777-777777777777",
    mediaType: "application/json" as const,
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

describe("ProfessionSourceContextController", () => {
  const getSkillSourceContext = vi.fn();
  let controller: ProfessionSourceContextController;

  beforeEach(() => {
    vi.resetAllMocks();
    controller = new ProfessionSourceContextController({
      getSkillSourceContext,
    } as unknown as ProfessionSourceContextService);
  });

  it("requires Worker authentication and delegates the exact lease DTO", async () => {
    getSkillSourceContext.mockResolvedValue(context);

    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      ProfessionSourceContextController,
    ) as unknown[] | undefined;
    expect(guards).toContain(WorkerTokenGuard);
    await expect(
      controller.getSkillSourceContext(jobId, input),
    ).resolves.toEqual(context);
    expect(getSkillSourceContext).toHaveBeenCalledWith(jobId, input);
  });

  it("fails closed when the Service response exposes a storage key or local path", async () => {
    getSkillSourceContext.mockResolvedValue({
      ...context,
      objectKey: "artifacts/source-run/private.json",
      sourcePath: "C:\\Game\\ImagePacks2\\source.npk",
    });

    await expect(
      controller.getSkillSourceContext(jobId, input),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});
