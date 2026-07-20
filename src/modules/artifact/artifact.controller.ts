import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import {
  createArtifactSchema,
  type ArtifactView,
  type CreateArtifactInput,
} from "./artifact.contracts.js";
import { ArtifactService } from "./artifact.service.js";

@Controller("runs/:runId/artifacts")
export class ArtifactController {
  constructor(private readonly artifacts: ArtifactService) {}

  @Get()
  list(@Param("runId") runId: string): Promise<ArtifactView[]> {
    return this.artifacts.listByRun(runId);
  }

  @Post()
  create(
    @Param("runId") runId: string,
    @Body(new ZodValidationPipe(createArtifactSchema))
    input: CreateArtifactInput,
  ): Promise<ArtifactView> {
    return this.artifacts.create(runId, input);
  }
}
