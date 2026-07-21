import { Module } from "@nestjs/common";
import { ArtifactModule } from "../artifact/artifact.module.js";
import { NpkModule } from "../npk/npk.module.js";
import { ProjectModule } from "../project/project.module.js";
import { RunModule } from "../run/run.module.js";
import {
  ProfessionCatalogController,
  ProfessionController,
} from "./profession.controller.js";
import { ProfessionRepository } from "./profession.repository.js";
import { ProfessionService } from "./profession.service.js";

@Module({
  imports: [ArtifactModule, NpkModule, ProjectModule, RunModule],
  controllers: [ProfessionController, ProfessionCatalogController],
  providers: [ProfessionRepository, ProfessionService],
  exports: [ProfessionService],
})
export class ProfessionModule {}
