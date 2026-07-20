import { Module } from "@nestjs/common";
import { ArtifactModule } from "../artifact/artifact.module.js";
import { RunModule } from "../run/run.module.js";
import { NpkController } from "./npk.controller.js";
import { NpkRepository } from "./npk.repository.js";
import { NpkService } from "./npk.service.js";

@Module({
  imports: [ArtifactModule, RunModule],
  controllers: [NpkController],
  providers: [NpkRepository, NpkService],
  exports: [NpkService],
})
export class NpkModule {}
