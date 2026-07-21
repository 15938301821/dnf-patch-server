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
import { sha256JcsV1 } from "../../common/utils/canonical.js";
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
      | "RESOURCE_IMPORT_SNAPSHOT_ID",
  ): boolean | string | undefined;
}

interface ResourceImportJobRepositoryPort {
  findLatestByProject(projectId: string): Promise<JobStateView | undefined>;
  findByRun(runId: string): Promise<JobStateView | undefined>;
}

interface InventoryLookupPort {
  findLatest(projectId: string): ReturnType<NpkService["findLatest"]>;
  findByRun(
    projectId: string,
    runId: string,
  ): ReturnType<NpkService["findByRun"]>;
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

type FactoryV2Config = Extract<
  Awaited<ReturnType<FactoryService["get"]>>["config"],
  { schemaVersion: 2 }
>;

interface ResourceImportContext {
  projectId: string;
  snapshotId: string;
  snapshot: Awaited<ReturnType<ProjectService["getSnapshot"]>>;
  factoryConfig: FactoryV2Config;
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
    const { projectId } = resolution.context;
    const latestJob = await this.jobs.findLatestByProject(projectId);
    if (!latestJob) {
      const latestInventory = await this.inventories.findLatest(projectId);
      return readyOverview(
        "idle",
        latestInventory
          ? "已找到项目最近的 frozen Inventory，尚无资源导入任务记录。"
          : "受控资源导入上下文已就绪，尚未提交导入任务。",
        latestInventory ? inventoryEvidence(latestInventory) : {},
      );
    }
    const [currentInventory, latestInventory] = await Promise.all([
      this.inventories.findByRun(projectId, latestJob.runId),
      this.inventories.findLatest(projectId),
    ]);
    return overviewFromEvidence(latestJob, currentInventory, latestInventory);
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
    const latestJob = await this.jobs.findLatestByProject(
      resolution.context.projectId,
    );
    if (latestJob?.status === "queued" || latestJob?.status === "leased") {
      return toResourceImportJob(latestJob);
    }
    const generation = latestJob?.id ?? "initial";
    const run = await this.runs.create(
      createImportRunInput(resolution.context, generation),
      `resource-import.${generation}`,
    );
    const created = await this.jobs.findByRun(run.id);
    if (!created) {
      throw new ConflictException({
        code: "RESOURCE_IMPORT_JOB_NOT_CREATED",
        message: "资源导入任务未通过服务端门禁。",
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
    if (
      typeof projectIdValue !== "string" ||
      typeof snapshotIdValue !== "string"
    ) {
      return {
        ready: false,
        message: "服务端尚未配置资源导入 Project 与 Snapshot。",
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
      const inventoryContract =
        factory.config.schemaVersion === 2
          ? factory.config.jobContracts.find(
              (contract) => contract.kind === "inventory",
            )
          : undefined;
      if (
        !factory.enabled ||
        factory.config.schemaVersion !== 2 ||
        !factory.config.allowedJobKinds.includes("inventory") ||
        inventoryContract?.schemaVersion !== 1
      ) {
        return {
          ready: false,
          message: "资源导入 Factory 未启用 inventory v1 契约。",
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
  const payload = {
    schemaVersion: 1 as const,
    profileId: context.factoryConfig.profileId,
    parameters: {
      workflow: "resource-inventory-import-v1",
      mode: "server-mirror",
      projectId: context.projectId,
      snapshotId: context.snapshotId,
      snapshotEvidence: {
        rootRulesSha256: context.snapshot.rootRulesSha256,
        promptTreeSha256: context.snapshot.promptTreeSha256,
        toolCatalogSha256: context.snapshot.toolCatalogSha256,
        ...(context.snapshot.manifestSha256
          ? { manifestSha256: context.snapshot.manifestSha256 }
          : {}),
      },
      deploymentAuthorized: false,
    },
  };
  const request = {
    schemaVersion: 1,
    action: "import-resources",
    projectId: context.projectId,
    snapshotId: context.snapshotId,
    payload,
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
    jobs: [{ kind: "inventory", payload, maxAttempts: 3 }],
    policyId: context.factoryConfig.policyId,
    policySha256: context.factoryConfig.policySha256,
  };
}

function overviewFromEvidence(
  job: JobStateView,
  currentInventory: Awaited<ReturnType<NpkService["findByRun"]>>,
  latestInventory: Awaited<ReturnType<NpkService["findLatest"]>>,
): ResourceImportOverview {
  const inventory = currentInventory ?? latestInventory;
  const evidence = inventory ? inventoryEvidence(inventory) : {};
  if (job.status === "queued") {
    return readyOverview("queued", "资源导入任务正在等待 Worker 领取。", {
      lastJobId: job.id,
      ...evidence,
    });
  }
  if (job.status === "leased") {
    return readyOverview("running", "inventory Worker 正在生成资源清单证据。", {
      lastJobId: job.id,
      ...evidence,
    });
  }
  if (job.status === "passed" && currentInventory) {
    return readyOverview("idle", "最近一次资源导入已形成 frozen Inventory。", {
      lastJobId: job.id,
      ...evidence,
    });
  }
  return readyOverview(
    "failed",
    job.status === "passed"
      ? "资源任务已结束，但缺少同 Run 的 frozen Inventory 证据。"
      : "最近一次资源导入任务失败或被安全门禁阻断。",
    { lastJobId: job.id, ...evidence },
  );
}

function inventoryEvidence(
  inventory: NonNullable<Awaited<ReturnType<NpkService["findLatest"]>>>,
): Pick<ResourceImportOverview, "resourceVersion" | "lastImportedAt"> {
  return {
    resourceVersion: inventory.sourceSha256,
    lastImportedAt: inventory.createdAtUtc,
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

function toResourceImportJob(job: JobStateView): ResourceImportJob {
  return {
    id: job.id,
    mode: "server-mirror",
    status:
      job.status === "queued"
        ? "queued"
        : job.status === "leased"
          ? "running"
          : "failed",
    createdAt: job.createdAtUtc,
  };
}
