/**
 * @fileoverview 验证共享特效模板创建只冻结已验证来源，并在缺少策略或 Worker 时拒绝调度。
 * @module job
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-001-SHARED-FX
 */
import { ConflictException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FactoryView } from "../factory/factory.contracts.js";
import type {
  ProjectSnapshotView,
  ProjectView,
} from "../project/project.contracts.js";
import type {
  CreateRunInput,
  RunCreateOptions,
  RunView,
} from "../run/run.contracts.js";
import { sharedFxJobPayloadV1Schema } from "./shared-fx.contracts.js";
import { createSharedFxTaskSchema } from "./shared-fx-task.contracts.js";
import { SharedFxTaskService } from "./shared-fx-task.service.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const snapshotId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const ownerUserId = "44444444-4444-4444-8444-444444444444";
const createdAt = "2026-07-22T00:00:00.000Z";
const input = {
  projectId,
  snapshotId,
  clientRunId: "shared-fx.request-1",
};

describe("SharedFxTaskService", () => {
  const projects = {
    get: vi.fn<(id: string) => Promise<ProjectView>>(),
    getSnapshot:
      vi.fn<
        (projectId: string, snapshotId: string) => Promise<ProjectSnapshotView>
      >(),
  };
  const factories = { get: vi.fn<(id: string) => Promise<FactoryView>>() };
  const workers = {
    hasEnabledCapability:
      vi.fn<(capability: "shared-fx") => Promise<boolean>>(),
  };
  const runs = {
    create:
      vi.fn<
        (
          input: CreateRunInput,
          idempotencyKey: string,
          options?: RunCreateOptions,
        ) => Promise<RunView>
      >(),
  };
  let service: SharedFxTaskService;

  beforeEach(() => {
    vi.resetAllMocks();
    projects.get.mockResolvedValue(project());
    projects.getSnapshot.mockResolvedValue(snapshot());
    factories.get.mockResolvedValue(factory());
    workers.hasEnabledCapability.mockResolvedValue(true);
    runs.create.mockResolvedValue(run());
    service = new SharedFxTaskService(projects, factories, workers, runs);
  });

  it("freezes a shared-fx payload from the Project Snapshot and Factory policy", async () => {
    await expect(
      service.create(input, "shared-fx.request-1", ownerUserId),
    ).resolves.toEqual({ id: runId, status: "queued", createdAt });

    const [runInput, idempotencyKey, options] = runs.create.mock.calls[0] ?? [];
    expect(idempotencyKey).toBe("shared-fx.request-1");
    expect(options).toEqual({ ownerUserId });
    expect(runInput).toMatchObject({
      projectId,
      snapshotId,
      clientRunId: input.clientRunId,
      action: "generate-shared-fx",
      modelEgressAuthorized: false,
      deploymentAuthorized: false,
      deploymentPerformed: false,
      fullSkillCoverageProven: false,
      clientCompatibilityProven: false,
    });
    const job = runInput?.jobs[0];
    expect(job?.kind).toBe("shared-fx");
    const payload = sharedFxJobPayloadV1Schema.parse(job?.payload);
    expect(payload.parameters.sourceSnapshot).toEqual({
      snapshotId,
      rootRulesSha256: "A".repeat(64),
      manifestSha256: "B".repeat(64),
      promptTreeSha256: "C".repeat(64),
      toolCatalogSha256: "D".repeat(64),
    });
    expect(payload.parameters.policy).toEqual({
      policyId: "shared-fx-policy",
      policySha256: "E".repeat(64),
    });
    expect(workers.hasEnabledCapability).toHaveBeenCalledWith("shared-fx");
  });

  it("fails closed before Run creation when the Snapshot lacks a manifest hash", async () => {
    projects.getSnapshot.mockResolvedValue({
      ...snapshot(),
      manifestSha256: undefined,
    });

    await expect(
      service.create(input, "shared-fx.request-1", ownerUserId),
    ).rejects.toMatchObject({
      response: { code: "SHARED_FX_MANIFEST_REQUIRED" },
    });
    expect(runs.create).not.toHaveBeenCalled();
  });

  it("fails closed when Factory has not registered the shared-fx contract", async () => {
    factories.get.mockResolvedValue(factoryWithoutSharedFx());

    await expect(
      service.create(input, "shared-fx.request-1", ownerUserId),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(runs.create).not.toHaveBeenCalled();
  });

  it("requires an enabled shared-fx Worker before Run creation", async () => {
    workers.hasEnabledCapability.mockResolvedValue(false);

    await expect(
      service.create(input, "shared-fx.request-1", ownerUserId),
    ).rejects.toMatchObject({
      response: { code: "SHARED_FX_WORKER_REQUIRED" },
    });
    expect(runs.create).not.toHaveBeenCalled();
  });
});

describe("createSharedFxTaskSchema", () => {
  it("accepts only source identifiers and rejects caller-supplied execution data", () => {
    expect(createSharedFxTaskSchema.safeParse(input).success).toBe(true);
    expect(
      createSharedFxTaskSchema.safeParse({
        ...input,
        sourcePath: "C:\\Games\\DNF",
      }).success,
    ).toBe(false);
  });
});

function project(): ProjectView {
  return {
    id: projectId,
    factoryId: "shared-fx-factory",
    displayName: "Shared FX Project",
    canonicalName: "shared fx project",
    version: 1,
    archived: false,
    createdAtUtc: createdAt,
    updatedAtUtc: createdAt,
  };
}

function snapshot(): ProjectSnapshotView {
  return {
    id: snapshotId,
    projectId,
    clientSnapshotId: "shared-fx-snapshot",
    rootRulesSha256: "A".repeat(64),
    manifestSha256: "B".repeat(64),
    promptTreeSha256: "C".repeat(64),
    toolCatalogSha256: "D".repeat(64),
    fullSkillCoverageProven: false,
    createdAtUtc: createdAt,
  };
}

function factory(): FactoryView {
  return {
    id: "shared-fx-factory",
    version: "2.0.0",
    displayName: "Shared FX Factory",
    config: {
      schemaVersion: 2,
      profileId: "shared-fx-profile",
      policyId: "shared-fx-policy",
      policySha256: "E".repeat(64),
      allowedJobKinds: ["shared-fx"],
      jobContracts: [{ kind: "shared-fx", schemaVersion: 1 }],
      arbitraryExecution: false,
      deploymentAuthorized: false,
    },
    configSha256: "F".repeat(64),
    enabled: true,
    createdAtUtc: createdAt,
  };
}

function factoryWithoutSharedFx(): FactoryView {
  return {
    ...factory(),
    config: {
      schemaVersion: 2,
      profileId: "shared-fx-profile",
      policyId: "shared-fx-policy",
      policySha256: "E".repeat(64),
      allowedJobKinds: ["inventory"],
      jobContracts: [{ kind: "inventory", schemaVersion: 1 }],
      arbitraryExecution: false,
      deploymentAuthorized: false,
    },
  };
}

function run(): RunView {
  return {
    id: runId,
    projectId,
    snapshotId,
    clientRunId: input.clientRunId,
    action: "generate-shared-fx",
    status: "queued",
    currentStage: "queued",
    requestSha256: "0".repeat(64),
    serverConnectionEnabled: true,
    modelEgressAuthorized: false,
    deploymentAuthorized: false,
    deploymentPerformed: false,
    fullSkillCoverageProven: false,
    clientCompatibilityProven: false,
    createdAtUtc: createdAt,
    updatedAtUtc: createdAt,
  };
}
