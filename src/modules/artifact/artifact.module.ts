import { Module } from "@nestjs/common";
import { ArtifactController } from "./artifact.controller.js";
import { ArtifactRepository } from "./artifact.repository.js";
import { ArtifactService } from "./artifact.service.js";

@Module({
  controllers: [ArtifactController],
  providers: [ArtifactRepository, ArtifactService],
  exports: [ArtifactService],
})
export class ArtifactModule {}
