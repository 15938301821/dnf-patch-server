/**
 * @fileoverview 验证资源导入接口只调度受控 inventory Job，并基于 frozen Inventory 判定成功。
 * @module job
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端资源导入业务直接需求）
 */
import { ConflictException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceImportSourceCatalog } from "../../../src/config/resource-import-source-catalog.js";
import type { FactoryView } from "../../../src/modules/factory/factory.contracts.js";
import type { InventoryView } from "../../../src/modules/npk/npk.contracts.js";
import type {
  ProjectSnapshotView,
  ProjectView,
} from "../../../src/modules/project/project.contracts.js";
import type { CreateRunInput, RunView } from "../../../src/modules/run/run.contracts.js";
import { parseJobPayload } from "../../../src/modules/job/job-payload-contracts.js";
import { createResourceImportJobSchema } from "../../../src/modules/job/resource-import.contracts.js";
import { ResourceImportService } from "../../../src/modules/job/resource-import.service.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const snapshotId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
const secondJobId = "55555555-5555-4555-8555-555555555555";
const timestamp = "2026-07-21T00:00:00.000Z";

interface ResourceImportJobStateFixture {
  id: string;
  runId: string;
  status: "queued" | "leased" | "passed";
  createdAtUtc: string;
  updatedAtUtc: string;
}

describe("ResourceImportService", () => {
  const configValues = new Map<
    string,
    boolean | string | ResourceImportSourceCatalog
  >();
  const config = {
    get: vi.fn(
      (
        key: string,
      ): boolean | string | ResourceImportSourceCatalog | undefined =>
        configValues.get(key),
    ),
  };
  const jobs = {
    findLatestRunByProject:
      vi.fn<(projectId: string) => Promise<ResourceImportJobStateFixture[]>>(),
    findByRun:
      vi.fn<(runId: string) => Promise<ResourceImportJobStateFixture[]>>(),
  };
  const inventories = {
    findAllByRun:
      vi.fn<(projectId: string, runId: string) => Promise<InventoryView[]>>(),
  };
  const workers = {
    hasEnabledCapability:
      vi.fn<(capability: "inventory") => Promise<boolean>>(),
  };
  const projects = {
    get: vi.fn<(id: string) => Promise<ProjectView>>(),
    getSnapshot:
      vi.fn<
        (projectId: string, snapshotId: string) => Promise<ProjectSnapshotView>
      >(),
  };
  const factories = { get: vi.fn<(id: string) => Promise<FactoryView>>() };
  const runs = {
    create:
      vi.fn<
        (input: CreateRunInput, idempotencyKey: string) => Promise<RunView>
      >(),
  };
  let service: ResourceImportService;

  beforeEach(() => {
    vi.resetAllMocks();
    configValues.clear();
    configValues.set("RESOURCE_IMPORT_SERVER_MIRROR_ENABLED", true);
    configValues.set("RESOURCE_IMPORT_PROJECT_ID", projectId);
    configValues.set("RESOURCE_IMPORT_SNAPSHOT_ID", snapshotId);
    configValues.set("RESOURCE_IMPORT_SOURCE_CATALOG_JSON", sourceCatalog());
    config.get.mockImplementation(
      (
        key: string,
      ): boolean | string | ResourceImportSourceCatalog | undefined =>
        configValues.get(key),
    );
    projects.get.mockResolvedValue({
      id: projectId,
      factoryId: "factory-v2",
      displayName: "Resource Import Project",
      canonicalName: "resource import project",
      version: 1,
      archived: false,
      createdAtUtc: timestamp,
      updatedAtUtc: timestamp,
    });
    projects.getSnapshot.mockResolvedValue(snapshot());
    factories.get.mockResolvedValue(factory());
    workers.hasEnabledCapability.mockResolvedValue(true);
    jobs.findLatestRunByProject.mockResolvedValue([]);
    jobs.findByRun.mockResolvedValue(batchJobs("queued"));
    inventories.findAllByRun.mockResolvedValue([]);
    runs.create.mockResolvedValue(run());
    service = new ResourceImportService(
      config,
      jobs,
      inventories,
      workers,
      projects,
      factories,
      runs,
    );
  });

  it("fails closed when the server mirror is not enabled", async () => {
    configValues.set("RESOURCE_IMPORT_SERVER_MIRROR_ENABLED", false);

    await expect(service.overview()).resolves.toMatchObject({
      mode: "server-mirror",
      status: "not-configured",
      resourceRootConfigured: false,
    });
    await expect(service.create()).rejects.toBeInstanceOf(ConflictException);
    expect(projects.get).not.toHaveBeenCalled();
    expect(runs.create).not.toHaveBeenCalled();
  });

  it("reuses an active inventory batch", async () => {
    jobs.findLatestRunByProject.mockResolvedValue([
      job("leased", jobId),
      job("queued", secondJobId),
    ]);

    await expect(service.create()).resolves.toEqual({
      id: jobId,
      mode: "server-mirror",
      status: "running",
      createdAt: timestamp,
    });
    expect(runs.create).not.toHaveBeenCalled();
  });

  it("shows the configured source count before the first import batch", async () => {
    const overview = await service.overview();
    expect(overview.status).toBe("idle");
    expect(overview.message).toContain("2 个官方来源");
    expect(inventories.findAllByRun).not.toHaveBeenCalled();
  });

  it("creates one guarded multi-source Run with immutable safety defaults", async () => {
    await expect(service.create()).resolves.toMatchObject({
      id: jobId,
      status: "queued",
    });
    const [input, idempotencyKey] = runs.create.mock.calls[0] ?? [];
    expect(input).toBeDefined();
    if (!input) throw new Error("RESOURCE_IMPORT_RUN_INPUT_MISSING");
    expect(idempotencyKey).toBe("resource-import.initial");
    expect(input).toMatchObject({
      projectId,
      snapshotId,
      action: "import-resources",
      modelEgressAuthorized: false,
      deploymentAuthorized: false,
      deploymentPerformed: false,
      fullSkillCoverageProven: false,
      clientCompatibilityProven: false,
    });
    expect(input.jobs).toHaveLength(2);
    expect(input.jobs[0]?.kind).toBe("inventory");
    const payload = parseJobPayload("inventory", 2, input.jobs[0]?.payload);
    expect(payload).toMatchObject({
      schemaVersion: 2,
      profileId: "resource-profile",
      sourceId: "momentaryslash",
      sourceSha256: "E".repeat(64),
      parameters: {
        workflow: "resource-inventory-import-v2",
        mode: "server-mirror",
        deploymentAuthorized: false,
      },
    });
    expect(JSON.stringify(input.jobs)).not.toContain("ImagePacks2");
  });

  it("uses the Factory v3 inventory contract profile", async () => {
    factories.get.mockResolvedValue({
      ...factory(),
      version: "3.0.0",
      config: {
        schemaVersion: 3,
        policyId: "production-policy",
        policySha256: "9".repeat(64),
        allowedJobKinds: ["inventory", "profession"],
        jobContracts: [
          {
            kind: "inventory",
            schemaVersion: 2,
            profileId: "resource-profile",
          },
          {
            kind: "profession",
            schemaVersion: 1,
            profileId: "aseprite-production-v1",
          },
        ],
        arbitraryExecution: false,
        deploymentAuthorized: false,
      },
    });

    await service.create();

    const input = runs.create.mock.calls[0]?.[0];
    expect(input).toBeDefined();
    const payload = parseJobPayload("inventory", 2, input?.jobs[0]?.payload);
    expect(payload.profileId).toBe("resource-profile");
  });

  it("requires every same-Run source Inventory before reporting success", async () => {
    jobs.findLatestRunByProject.mockResolvedValue(batchJobs("passed"));

    await expect(service.overview()).resolves.toMatchObject({
      status: "failed",
      lastJobId: secondJobId,
    });

    inventories.findAllByRun.mockResolvedValue([
      inventory("momentaryslash", "E".repeat(64), "inventory-first"),
      inventory("illusionslash", "F".repeat(64), "inventory-second"),
    ]);
    const overview = await service.overview();
    expect(overview).toMatchObject({
      status: "idle",
      lastImportedAt: timestamp,
      lastJobId: secondJobId,
    });
    expect(overview.resourceVersion).toMatch(/^[A-F0-9]{64}$/u);
  });
});

describe("createResourceImportJobSchema", () => {
  it("accepts no body and rejects caller-supplied paths or parameters", () => {
    expect(createResourceImportJobSchema.safeParse(undefined).success).toBe(
      true,
    );
    expect(createResourceImportJobSchema.safeParse({}).success).toBe(true);
    expect(
      createResourceImportJobSchema.safeParse({
        resourceRoot: "C:\\Games\\DNF",
      }).success,
    ).toBe(false);
  });
});

function job(
  status: ResourceImportJobStateFixture["status"],
  id = jobId,
): ResourceImportJobStateFixture {
  return {
    id,
    runId,
    status,
    createdAtUtc: timestamp,
    updatedAtUtc: timestamp,
  };
}

function batchJobs(
  status: ResourceImportJobStateFixture["status"],
): ResourceImportJobStateFixture[] {
  return [job(status, jobId), job(status, secondJobId)];
}

function snapshot(): ProjectSnapshotView {
  return {
    id: snapshotId,
    projectId,
    clientSnapshotId: "resource-snapshot",
    rootRulesSha256: "A".repeat(64),
    manifestSha256: "B".repeat(64),
    promptTreeSha256: "C".repeat(64),
    toolCatalogSha256: "D".repeat(64),
    fullSkillCoverageProven: false,
    createdAtUtc: timestamp,
  };
}

function inventory(
  sourceId: string,
  sourceSha256: string,
  id: string,
): InventoryView {
  return {
    id,
    projectId,
    runId,
    sourceId,
    sourceLabel: "verified server mirror",
    sourceLength: 1,
    sourceSha256,
    status: "frozen",
    entryCount: 1,
    createdAtUtc: timestamp,
  };
}

function sourceCatalog(): ResourceImportSourceCatalog {
  return {
    schemaVersion: 1,
    sources: [
      { sourceId: "momentaryslash", sourceSha256: "E".repeat(64) },
      { sourceId: "illusionslash", sourceSha256: "F".repeat(64) },
    ],
  };
}

function factory(): FactoryView {
  return {
    id: "factory-v2",
    version: "2.0.0",
    displayName: "Resource Inventory Factory",
    config: {
      schemaVersion: 2 as const,
      profileId: "resource-profile",
      policyId: "resource-policy",
      policySha256: "F".repeat(64),
      allowedJobKinds: ["inventory" as const],
      jobContracts: [{ kind: "inventory" as const, schemaVersion: 2 as const }],
      arbitraryExecution: false as const,
      deploymentAuthorized: false as const,
    },
    configSha256: "0".repeat(64),
    enabled: true,
    createdAtUtc: timestamp,
  };
}

function run(): RunView {
  return {
    id: runId,
    projectId,
    snapshotId,
    clientRunId: "resource-import.initial",
    action: "import-resources",
    status: "queued",
    currentStage: "queued",
    requestSha256: "1".repeat(64),
    serverConnectionEnabled: true,
    modelEgressAuthorized: false,
    deploymentAuthorized: false,
    deploymentPerformed: false,
    fullSkillCoverageProven: false,
    clientCompatibilityProven: false,
    createdAtUtc: timestamp,
    updatedAtUtc: timestamp,
  };
}
