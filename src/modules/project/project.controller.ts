import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { idSchema } from "../../common/contracts/index.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import {
  createProjectSchema,
  projectSnapshotSchema,
  type CreateProjectInput,
  type CreateProjectSnapshotInput,
  type ProjectSnapshotView,
  type ProjectView,
} from "./project.contracts.js";
import { ProjectService } from "./project.service.js";

@Controller("projects")
export class ProjectController {
  constructor(private readonly projects: ProjectService) {}

  @Get()
  list(): Promise<ProjectView[]> {
    return this.projects.list();
  }

  @Get(":id")
  get(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
  ): Promise<ProjectView> {
    return this.projects.get(id);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createProjectSchema)) input: CreateProjectInput,
  ): Promise<ProjectView> {
    return this.projects.create(input);
  }

  @Post(":id/snapshots")
  createSnapshot(
    @Param("id", new ZodValidationPipe(idSchema)) projectId: string,
    @Body(new ZodValidationPipe(projectSnapshotSchema))
    input: CreateProjectSnapshotInput,
  ): Promise<ProjectSnapshotView> {
    return this.projects.createSnapshot(projectId, input);
  }
}
