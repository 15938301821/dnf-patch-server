import { Module } from "@nestjs/common";
import { RunModule } from "../run/run.module.js";
import { ArtifactController } from "./artifact.controller.js";
import { ArtifactRepository } from "./artifact.repository.js";
import { ArtifactService } from "./artifact.service.js";

@Module({
  imports: [RunModule],
  controllers: [ArtifactController],
  providers: [ArtifactRepository, ArtifactService],
  exports: [ArtifactService],
})
export class ArtifactModule {}
