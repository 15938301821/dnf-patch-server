/**
 * @fileoverview 验证 Profession 单技能输出接收事务只接受当前 attempt 的模型链与 finalized 双上传；
 * 不连接真实 MySQL、不读取对象正文，也不证明复合外键、锁竞争、NPK 或客户端兼容。
 * @module modules/job/patch-task-skill-production-repository-support-spec
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：Vitest 用按查询顺序返回行的最小 Drizzle transaction stub 调用真实接收函数和 evidence
 * helper。测试保护旧 lease、错误 Artist execution、非 finalized 会话和错角色 provenance 都必须在
 * production 更新前失败；真实 CHECK、复合外键和并发 row lock 仍需隔离 MySQL 验证。
 */
import { describe, expect, it } from "vitest";
import {
  createSkillProductionReportHarness,
  skillProductionFixture,
} from "./patch-task-skill-production.repository-fixture.js";
import { reportProfessionSkillProduction } from "./patch-task-skill-production.repository-support.js";

describe("reportProfessionSkillProduction", () => {
  it("writes Server-derived model IDs and both current upload bindings atomically", async () => {
    const harness = createSkillProductionReportHarness();

    await expect(
      reportProfessionSkillProduction(
        harness.connection,
        skillProductionFixture.jobId,
        harness.input,
      ),
    ).resolves.toEqual({ status: "accepted" });
    expect(harness.updated).toContainEqual(
      expect.objectContaining({
        workerId: skillProductionFixture.workerId,
        leaseId: skillProductionFixture.leaseId,
        attempt: 2,
        modelCallId: skillProductionFixture.artistModelCallId,
        imageAttemptId: skillProductionFixture.imageAttemptId,
        asepriteProfileId: "aseprite-cli",
        asepriteUploadId: skillProductionFixture.projectsUploadId,
        validationUploadId: skillProductionFixture.validationUploadId,
        status: "passed",
        finishedAt: skillProductionFixture.now,
      }),
    );
    expect(harness.forUpdate).toHaveBeenCalledTimes(6);
  });

  it("rejects an old attempt before reading or writing production evidence", async () => {
    const harness = createSkillProductionReportHarness("old-attempt");

    await expect(
      reportProfessionSkillProduction(
        harness.connection,
        skillProductionFixture.jobId,
        harness.input,
      ),
    ).resolves.toEqual({ status: "lease-mismatch" });
    expect(harness.select).toHaveBeenCalledTimes(2);
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("rejects an Artist execution bound to another attempt without updating production", async () => {
    const harness = createSkillProductionReportHarness("artist-old-attempt");

    await expect(
      reportProfessionSkillProduction(
        harness.connection,
        skillProductionFixture.jobId,
        harness.input,
      ),
    ).resolves.toEqual({ status: "model-execution-evidence-mismatch" });
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("rejects a non-finalized projects upload without reading validation evidence", async () => {
    const harness = createSkillProductionReportHarness(
      "projects-not-finalized",
    );

    await expect(
      reportProfessionSkillProduction(
        harness.connection,
        skillProductionFixture.jobId,
        harness.input,
      ),
    ).resolves.toEqual({ status: "artifact-evidence-mismatch" });
    expect(harness.select).toHaveBeenCalledTimes(7);
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("rejects validation provenance carrying the projects role without updating production", async () => {
    const harness = createSkillProductionReportHarness(
      "validation-projects-role",
    );

    await expect(
      reportProfessionSkillProduction(
        harness.connection,
        skillProductionFixture.jobId,
        harness.input,
      ),
    ).resolves.toEqual({ status: "artifact-evidence-mismatch" });
    expect(harness.update).not.toHaveBeenCalled();
  });
});
