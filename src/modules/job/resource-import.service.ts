/**
 * @fileoverview 将浏览器资源导入请求映射为 inventory Run，并聚合数据库权威状态。
 * @module job
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端资源导入业务直接需求）
 */
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  resourceImportSourceCatalogSchema,
  type ResourceImportSourceCatalog,
} from "../../config/resource-import-source-catalog.js";
import { sha256JcsV1 } from "../../common/utils/canonical.js";
import { resolveFactoryJobContract } from "../factory/factory.contracts.js";
import { FactoryService } from "../factory/factory.service.js";
import { NpkService } from "../npk/npk.service.js";
import { ProjectService } from "../project/project.service.js";
import type { CreateRunInput } from "../run/run.contracts.js";
import { RunService } from "../run/run.service.js";
import { WorkerService } from "../worker/worker.service.js";
import type { JobStateView } from "./job.contracts.js";
import type {
  ResourceImportJob,
  ResourceImportOverview,
} from "./resource-import.contracts.js";
import { ResourceImportRepository } from "./resource-import.repository.js";

interface ResourceImportConfigPort {
  get(
    key:
      | "RESOURCE_IMPORT_SERVER_MIRROR_ENABLED"
      | "RESOURCE_IMPORT_PROJECT_ID"
      | "RESOURCE_IMPORT_SNAPSHOT_ID"
      | "RESOURCE_IMPORT_SOURCE_CATALOG_JSON",
  ): boolean | string | ResourceImportSourceCatalog | undefined;
}

interface ResourceImportJobRepositoryPort {
  findLatestRunByProject(projectId: string): Promise<JobStateView[]>;
  findByRun(runId: string): Promise<JobStateView[]>;
}

interface InventoryLookupPort {
  findAllByRun(
    projectId: string,
    runId: string,
  ): ReturnType<NpkService["findAllByRun"]>;
}

interface WorkerCapabilityPort {
  hasEnabledCapability(
    capability: "inventory",
  ): ReturnType<WorkerService["hasEnabledCapability"]>;
}

interface ProjectLookupPort {
  get(id: string): ReturnType<ProjectService["get"]>;
  getSnapshot(
    projectId: string,
    snapshotId: string,
  ): ReturnType<ProjectService["getSnapshot"]>;
}

interface FactoryLookupPort {
  get(id: string): ReturnType<FactoryService["get"]>;
}

interface RunCreatePort {
  create(
    input: CreateRunInput,
    idempotencyKey: string,
  ): ReturnType<RunService["create"]>;
}

type RunnableFactoryConfig = Extract<
  Awaited<ReturnType<FactoryService["get"]>>["config"],
  { schemaVersion: 2 | 3 }
>;

interface ResourceImportContext {
  projectId: string;
  snapshotId: string;
  snapshot: Awaited<ReturnType<ProjectService["getSnapshot"]>>;
  factoryConfig: RunnableFactoryConfig;
  inventoryProfileId: string;
  sourceCatalog: ResourceImportSourceCatalog;
}

type ResourceImportContextResolution =
  | { ready: true; context: ResourceImportContext }
  | { ready: false; message: string };

@Injectable()
export class ResourceImportService {
  constructor(
    @Inject(ConfigService)
    private readonly config: ResourceImportConfigPort,
    @Inject(ResourceImportRepository)
    private readonly jobs: ResourceImportJobRepositoryPort,
    @Inject(NpkService) private readonly inventories: InventoryLookupPort,
    @Inject(WorkerService) private readonly workers: WorkerCapabilityPort,
    @Inject(ProjectService) private readonly projects: ProjectLookupPort,
    @Inject(FactoryService) private readonly factories: FactoryLookupPort,
    @Inject(RunService) private readonly runs: RunCreatePort,
  ) {}

  /** 聚合配置、Worker、Job 与 frozen Inventory 证据，不读取资源根路径。 */
  async overview(): Promise<ResourceImportOverview> {
    const resolution = await this.resolveContext();
    if (!resolution.ready) {
      return notConfiguredOverview(resolution.message);
    }
    const { projectId, sourceCatalog } = resolution.context;
    const latestJobs = await this.jobs.findLatestRunByProject(projectId);
    if (latestJobs.length === 0) {
      return readyOverview(
        "idle",
        `受控资源导入上下文已就绪，共 ${String(sourceCatalog.sources.length)} 个官方来源，尚未提交导入任务。`,
      );
    }
    const runId = latestJobs[0]?.runId;
    if (runId === undefined || latestJobs.some((job) => job.runId !== runId)) {
      return readyOverview("failed", "资源导入批次 Job 归属不一致。");
    }
    const currentInventories = await this.inventories.findAllByRun(
      projectId,
      runId,
    );
    return overviewFromEvidence(latestJobs, currentInventories, sourceCatalog);
  }

  /** 创建固定的 server-mirror inventory Job；重复并发请求复用同一代 Run。 */
  async create(): Promise<ResourceImportJob> {
    const resolution = await this.resolveContext();
    if (!resolution.ready) {
      throw new ConflictException({
        code: "RESOURCE_IMPORT_NOT_CONFIGURED",
        message: resolution.message,
      });
    }
    const latestJobs = await this.jobs.findLatestRunByProject(
      resolution.context.projectId,
    );
    if (
      latestJobs.some(
        (job) => job.status === "queued" || job.status === "leased",
      )
    ) {
      return toResourceImportJob(latestJobs);
    }
    const generation = latestJobs[0]?.runId ?? "initial";
    const run = await this.runs.create(
      createImportRunInput(resolution.context, generation),
      `resource-import.${generation}`,
    );
    const created = await this.jobs.findByRun(run.id);
    if (created.length !== resolution.context.sourceCatalog.sources.length) {
      throw new ConflictException({
        code: "RESOURCE_IMPORT_JOB_NOT_CREATED",
        message: "资源导入批次未完整通过服务端门禁。",
      });
    }
    return toResourceImportJob(created);
  }

  private async resolveContext(): Promise<ResourceImportContextResolution> {
    if (this.config.get("RESOURCE_IMPORT_SERVER_MIRROR_ENABLED") !== true) {
      return {
        ready: false,
        message: "服务端尚未启用受控资源镜像导入。",
      };
    }
    const projectIdValue = this.config.get("RESOURCE_IMPORT_PROJECT_ID");
    const snapshotIdValue = this.config.get("RESOURCE_IMPORT_SNAPSHOT_ID");
    const sourceCatalogResult = resourceImportSourceCatalogSchema.safeParse(
      this.config.get("RESOURCE_IMPORT_SOURCE_CATALOG_JSON"),
    );
    if (
      typeof projectIdValue !== "string" ||
      typeof snapshotIdValue !== "string" ||
      !sourceCatalogResult.success
    ) {
      return {
        ready: false,
        message: "服务端尚未配置资源导入 Project、Snapshot 与逻辑来源目录。",
      };
    }
    const projectId = projectIdValue;
    const snapshotId = snapshotIdValue;
    try {
      const project = await this.projects.get(projectId);
      const snapshot = await this.projects.getSnapshot(projectId, snapshotId);
      const factory = await this.factories.get(project.factoryId);
      if (project.archived) {
        return { ready: false, message: "资源导入 Project 已归档。" };
      }
      if (!factory.enabled || factory.config.schemaVersion === 1) {
        return {
          ready: false,
          message: "资源导入 Factory 未启用 inventory v1 契约。",
        };
      }
      const inventoryContract = resolveFactoryJobContract(
        factory.config,
        "inventory",
      );
      if (inventoryContract?.schemaVersion !== 2) {
        return {
          ready: false,
          message: "资源导入 Factory 未启用 inventory v2 多来源契约。",
        };
      }
      if (!(await this.workers.hasEnabledCapability("inventory"))) {
        return {
          ready: false,
          message: "尚无启用的 inventory Worker 声明资源导入能力。",
        };
      }
      return {
        ready: true,
        context: {
          projectId,
          snapshotId,
          snapshot,
          factoryConfig: factory.config,
          inventoryProfileId: inventoryContract.profileId,
          sourceCatalog: sourceCatalogResult.data,
        },
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        return {
          ready: false,
          message: "资源导入 Project、Snapshot 或 Factory 配置无效。",
        };
      }
      throw error;
    }
  }
}

function createImportRunInput(
  context: ResourceImportContext,
  generation: string,
): CreateRunInput {
  const snapshotEvidence = {
    rootRulesSha256: context.snapshot.rootRulesSha256,
    promptTreeSha256: context.snapshot.promptTreeSha256,
    toolCatalogSha256: context.snapshot.toolCatalogSha256,
    ...(context.snapshot.manifestSha256
      ? { manifestSha256: context.snapshot.manifestSha256 }
      : {}),
  };
  const jobs = context.sourceCatalog.sources.map((source) => ({
    kind: "inventory" as const,
    payload: {
      schemaVersion: 2 as const,
      profileId: context.inventoryProfileId,
      sourceId: source.sourceId,
      sourceSha256: source.sourceSha256,
      parameters: {
        workflow: "resource-inventory-import-v2" as const,
        mode: "server-mirror" as const,
        projectId: context.projectId,
        snapshotId: context.snapshotId,
        snapshotEvidence,
        deploymentAuthorized: false as const,
      },
    },
    maxAttempts: 3,
  }));
  const request = {
    schemaVersion: 2,
    action: "import-resources",
    projectId: context.projectId,
    snapshotId: context.snapshotId,
    sourceCatalogSha256: sha256JcsV1(context.sourceCatalog),
  };
  return {
    projectId: context.projectId,
    snapshotId: context.snapshotId,
    clientRunId: `resource-import.${generation}`,
    action: "import-resources",
    requestSha256: sha256JcsV1(request),
    serverConnectionEnabled: true,
    modelEgressAuthorized: false,
    deploymentAuthorized: false,
    deploymentPerformed: false,
    fullSkillCoverageProven: false,
    clientCompatibilityProven: false,
    jobs,
    policyId: context.factoryConfig.policyId,
    policySha256: context.factoryConfig.policySha256,
  };
}

function overviewFromEvidence(
  jobs: readonly JobStateView[],
  inventories: Awaited<ReturnType<NpkService["findAllByRun"]>>,
  sourceCatalog: ResourceImportSourceCatalog,
): ResourceImportOverview {
  const lastJobId = jobs.at(-1)?.id;
  if (jobs.length !== sourceCatalog.sources.length) {
    return readyOverview("failed", "资源导入批次 Job 数量与来源目录不一致。", {
      ...(lastJobId ? { lastJobId } : {}),
    });
  }
  if (jobs.some((job) => job.status === "leased")) {
    return readyOverview(
      "running",
      `inventory Worker 正在处理 ${String(sourceCatalog.sources.length)} 个官方来源。`,
      { ...(lastJobId ? { lastJobId } : {}) },
    );
  }
  if (jobs.some((job) => job.status === "queued")) {
    return readyOverview(
      "queued",
      `资源导入批次正在等待 Worker，共 ${String(sourceCatalog.sources.length)} 个官方来源。`,
      { ...(lastJobId ? { lastJobId } : {}) },
    );
  }
  const batch = inspectInventoryBatch(inventories, sourceCatalog);
  if (jobs.every((job) => job.status === "passed") && batch.complete) {
    return readyOverview(
      "idle",
      `最近一次资源导入已形成 ${String(inventories.length)} 个 frozen Inventory。`,
      {
        ...(lastJobId === undefined ? {} : { lastJobId }),
        resourceVersion: sha256JcsV1(sourceCatalog),
        ...(batch.lastImportedAt === undefined
          ? {}
          : { lastImportedAt: batch.lastImportedAt }),
      },
    );
  }
  return readyOverview(
    "failed",
    jobs.every((job) => job.status === "passed")
      ? "资源任务已结束，但同 Run 的 frozen Inventory 未完整匹配来源目录。"
      : "最近一次资源导入批次失败或被安全门禁阻断。",
    { ...(lastJobId ? { lastJobId } : {}) },
  );
}

/** 核对来源 ID、摘要和数量，禁止用同 Run 任意一条 Inventory 冒充整批成功。 */
function inspectInventoryBatch(
  inventories: Awaited<ReturnType<NpkService["findAllByRun"]>>,
  sourceCatalog: ResourceImportSourceCatalog,
): { complete: boolean; lastImportedAt?: string } {
  const expected = new Map(
    sourceCatalog.sources.map((source) => [
      source.sourceId,
      source.sourceSha256.toUpperCase(),
    ]),
  );
  const seen = new Set<string>();
  let lastImportedAt: string | undefined;
  for (const inventory of inventories) {
    if (
      inventory.sourceId === undefined ||
      seen.has(inventory.sourceId) ||
      expected.get(inventory.sourceId) !== inventory.sourceSha256.toUpperCase()
    ) {
      return { complete: false };
    }
    seen.add(inventory.sourceId);
    if (
      lastImportedAt === undefined ||
      inventory.createdAtUtc > lastImportedAt
    ) {
      lastImportedAt = inventory.createdAtUtc;
    }
  }
  return {
    complete:
      inventories.length === expected.size && seen.size === expected.size,
    ...(lastImportedAt === undefined ? {} : { lastImportedAt }),
  };
}

function readyOverview(
  status: Exclude<ResourceImportOverview["status"], "not-configured">,
  message: string,
  evidence: Partial<
    Pick<
      ResourceImportOverview,
      "resourceVersion" | "lastImportedAt" | "lastJobId"
    >
  > = {},
): ResourceImportOverview {
  return {
    mode: "server-mirror",
    status,
    resourceRootConfigured: true,
    message,
    ...evidence,
  };
}

function notConfiguredOverview(message: string): ResourceImportOverview {
  return {
    mode: "server-mirror",
    status: "not-configured",
    resourceRootConfigured: false,
    message,
  };
}

function toResourceImportJob(jobs: readonly JobStateView[]): ResourceImportJob {
  const job = jobs[0];
  if (job === undefined) {
    throw new ConflictException({
      code: "RESOURCE_IMPORT_JOB_NOT_CREATED",
      message: "资源导入批次没有可用 Job。",
    });
  }
  return {
    id: job.id,
    mode: "server-mirror",
    status: jobs.some((candidate) => candidate.status === "leased")
      ? "running"
      : jobs.some((candidate) => candidate.status === "queued")
        ? "queued"
        : "failed",
    createdAt: job.createdAtUtc,
  };
}
