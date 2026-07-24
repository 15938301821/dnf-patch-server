/**
 * @fileoverview 验证单技能固定模型步骤的纯幂等状态分类；不连接数据库、不调用模型或对象存储。
 * @module modules/job/profession-model-execution-spec
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan /memories/session/plan.md - 单技能 Profession Worker 纵向链路
 *
 * 调用关系：Vitest 直接用持久化行 fixture 调用分类器。测试保护已消费出站权、绑定漂移和不完整
 * passed 证据永远不能变成新的 execute；真实并发串行由 Repository 事务测试覆盖。
 */
import { describe, expect, it } from "vitest";
import {
  classifyProfessionModelExecution,
  professionEngineerPlanStage,
  professionReferenceImageStage,
  type PersistedProfessionModelExecution,
  type ProfessionModelExecutionIdentity,
} from "./profession-model-execution.js";

const identity: ProfessionModelExecutionIdentity = {
  runId: "11111111-1111-4111-8111-111111111111",
  jobId: "22222222-2222-4222-8222-222222222222",
  workerId: "33333333-3333-4333-8333-333333333333",
  leaseId: "44444444-4444-4444-8444-444444444444",
  attempt: 2,
  skillId: "55555555-5555-4555-8555-555555555555",
  stage: professionReferenceImageStage,
  promptSha256: "A".repeat(64),
};

describe("classifyProfessionModelExecution", () => {
  it("allows only a prepared record to acquire the single egress right", () => {
    expect(classifyProfessionModelExecution(execution(), identity)).toEqual({
      status: "acquire",
      executionId: "66666666-6666-4666-8666-666666666666",
    });
  });

  it("treats egressing as in progress without reacquiring egress", () => {
    expect(
      classifyProfessionModelExecution(
        execution({ status: "egressing" }),
        identity,
      ),
    ).toEqual({
      status: "in-progress",
      executionId: "66666666-6666-4666-8666-666666666666",
    });
  });

  it("returns frozen evidence for a persistence-only recovery", () => {
    expect(
      classifyProfessionModelExecution(
        execution({
          status: "persisting",
          modelCallId: "77777777-7777-4777-8777-777777777777",
          outputSha256: "b".repeat(64),
          outputByteLength: 128,
        }),
        identity,
      ),
    ).toEqual({
      status: "persistence-pending",
      executionId: "66666666-6666-4666-8666-666666666666",
      modelCallId: "77777777-7777-4777-8777-777777777777",
      outputSha256: "B".repeat(64),
      outputByteLength: 128,
    });
  });

  it("returns complete passed evidence for recovery without a new call", () => {
    expect(
      classifyProfessionModelExecution(
        execution({
          status: "passed",
          modelCallId: "77777777-7777-4777-8777-777777777777",
          imageAttemptId: "88888888-8888-4888-8888-888888888888",
          outputArtifactId: "99999999-9999-4999-8999-999999999999",
          outputSha256: "b".repeat(64),
          outputByteLength: 128,
        }),
        identity,
      ),
    ).toMatchObject({
      status: "passed",
      stage: professionReferenceImageStage,
      outputSha256: "B".repeat(64),
      outputByteLength: 128,
    });
  });

  it("accepts Engineer passed evidence only without an ImageAttempt", () => {
    const engineerIdentity = {
      ...identity,
      stage: professionEngineerPlanStage,
    };
    expect(
      classifyProfessionModelExecution(
        execution({
          stage: professionEngineerPlanStage,
          status: "passed",
          modelCallId: "77777777-7777-4777-8777-777777777777",
          outputArtifactId: "99999999-9999-4999-8999-999999999999",
          outputSha256: "b".repeat(64),
          outputByteLength: 128,
        }),
        engineerIdentity,
      ),
    ).toMatchObject({
      status: "passed",
      stage: professionEngineerPlanStage,
      outputArtifactId: "99999999-9999-4999-8999-999999999999",
    });
    expect(
      classifyProfessionModelExecution(
        execution({
          stage: professionEngineerPlanStage,
          status: "passed",
          modelCallId: "77777777-7777-4777-8777-777777777777",
          imageAttemptId: "88888888-8888-4888-8888-888888888888",
          outputArtifactId: "99999999-9999-4999-8999-999999999999",
          outputSha256: "b".repeat(64),
          outputByteLength: 128,
        }),
        engineerIdentity,
      ),
    ).toEqual({ status: "execution-integrity-failed" });
  });

  it.each(["failed", "indeterminate"])(
    "returns the terminal %s error without a new call",
    (status) => {
      expect(
        classifyProfessionModelExecution(
          execution({ status, errorCode: "MODEL_STEP_TERMINAL" }),
          identity,
        ),
      ).toMatchObject({ status, errorCode: "MODEL_STEP_TERMINAL" });
    },
  );

  it("keeps a persistence-unknown execution terminal with recoverable evidence", () => {
    expect(
      classifyProfessionModelExecution(
        execution({
          status: "indeterminate",
          modelCallId: "77777777-7777-4777-8777-777777777777",
          outputSha256: "B".repeat(64),
          outputByteLength: 128,
          errorCode: "OBJECT_PERSISTENCE_INDETERMINATE",
        }),
        identity,
      ),
    ).toMatchObject({
      status: "indeterminate",
      errorCode: "OBJECT_PERSISTENCE_INDETERMINATE",
    });
  });

  it.each([
    ["worker", { workerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
    ["lease", { leaseId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
    ["attempt", { attempt: 3 }],
    ["skill", { skillId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }],
    ["stage", { stage: "arbitrary-stage" }],
    ["prompt", { promptSha256: "F".repeat(64) }],
  ])("rejects %s binding drift", (_label, override) => {
    expect(
      classifyProfessionModelExecution(execution(override), identity),
    ).toEqual({ status: "execution-integrity-failed" });
  });

  it("rejects a passed row missing persisted Artifact evidence", () => {
    expect(
      classifyProfessionModelExecution(
        execution({
          status: "passed",
          modelCallId: "77777777-7777-4777-8777-777777777777",
        }),
        identity,
      ),
    ).toEqual({ status: "execution-integrity-failed" });
  });
});

function execution(
  override: Partial<PersistedProfessionModelExecution> = {},
): PersistedProfessionModelExecution {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    ...identity,
    status: "prepared",
    modelCallId: null,
    imageAttemptId: null,
    outputArtifactId: null,
    outputSha256: null,
    outputByteLength: null,
    errorCode: null,
    ...override,
  };
}
