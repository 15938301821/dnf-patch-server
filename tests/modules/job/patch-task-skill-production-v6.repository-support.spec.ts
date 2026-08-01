/**
 * @fileoverview 验证Profession V6终态事务只接受当前attempt完整逐帧集合和匹配四Artifact；
 * 不连接真实MySQL、不读取对象正文，也不证明Aseprite或客户端兼容。
 * @module modules/job/patch-task-skill-production-v6-repository-support-spec
 * @author AI生成
 * @created 2026-08-01
 * @relatedPlan N/A - 用户直接要求实现Profession V6
 *
 * Mock边界：按真实查询顺序返回内存数据库行；CHECK、外键和并发row lock需test:mysql另证。
 */
import { describe, expect, it } from "vitest";
import { reportProfessionSkillProduction } from "../../../src/modules/job/patch-task-skill-production.repository-support.js";
import {
  createV6SkillProductionReportHarness,
  type V6SkillProductionScenario,
} from "./fixtures/patch-task-skill-production-v6.repository-fixture.js";
import { skillProductionFixture } from "./fixtures/patch-task-skill-production.fixture-ids.js";

describe("reportProfessionSkillProduction V6", () => {
  it("accepts a complete current-attempt target set and persists V6 evidence", async () => {
    const harness = createV6SkillProductionReportHarness();
    await expect(
      reportProfessionSkillProduction(
        harness.connection,
        skillProductionFixture.jobId,
        harness.input,
      ),
    ).resolves.toEqual({ status: "accepted" });
    expect(harness.updated).toContainEqual(
      expect.objectContaining({
        modelCallId: null,
        imageAttemptId: null,
        targetFrameCount: 1,
        asepriteProfileId: "aseprite-cli-v6",
        status: "passed",
      }),
    );
  });

  it.each([
    "frame-old-attempt",
    "frame-not-passed",
    "target-set-mismatch",
  ] satisfies V6SkillProductionScenario[])(
    "rejects %s before any production update",
    async (scenario) => {
      const harness = createV6SkillProductionReportHarness(scenario);
      await expect(
        reportProfessionSkillProduction(
          harness.connection,
          skillProductionFixture.jobId,
          harness.input,
        ),
      ).resolves.toEqual({ status: "skill-production-evidence-mismatch" });
      expect(harness.update).not.toHaveBeenCalled();
    },
  );

  it("rejects a preview target outside the recomputed set", async () => {
    const harness = createV6SkillProductionReportHarness(
      "preview-target-mismatch",
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
