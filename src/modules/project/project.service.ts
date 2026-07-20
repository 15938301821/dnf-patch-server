import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { canonicalName } from "../../common/utils/canonical.js";
import { FactoryService } from "../factory/factory.service.js";
import type {
  CreateProjectInput,
  CreateProjectSnapshotInput,
  ProjectSnapshotView,
  ProjectView,
} from "./project.contracts.js";
import { ProjectRepository } from "./project.repository.js";

@Injectable()
export class ProjectService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly factories: FactoryService,
  ) {}

  list(): Promise<ProjectView[]> {
    return this.projects.list();
  }

  async get(id: string): Promise<ProjectView> {
    const project = await this.projects.findById(id);
    if (!project) {
      throw new NotFoundException({
        code: "PROJECT_NOT_FOUND",
        message: "项目不存在。",
      });
    }
    return project;
  }

  async create(input: CreateProjectInput): Promise<ProjectView> {
    await this.factories.get(input.factoryId);
    const normalized = canonicalName(input.displayName);
    if (await this.projects.findByCanonicalName(normalized)) {
      throw new ConflictException({
        code: "PROJECT_NAME_CONFLICT",
        message: "规范化后的项目名称已存在。",
      });
    }
    return this.projects.create(input, randomUUID(), normalized);
  }

  async createSnapshot(
    projectId: string,
    input: CreateProjectSnapshotInput,
  ): Promise<ProjectSnapshotView> {
    await this.get(projectId);
    return this.projects.createSnapshot(projectId, input, randomUUID());
  }

  async getSnapshot(
    projectId: string,
    snapshotId: string,
  ): Promise<ProjectSnapshotView> {
    const snapshot = await this.projects.findSnapshotById(
      projectId,
      snapshotId,
    );
    if (!snapshot) {
      throw new NotFoundException({
        code: "PROJECT_SNAPSHOT_NOT_FOUND",
        message: "项目快照不存在或不属于当前项目。",
      });
    }
    return snapshot;
  }
}
