import { Module } from "@nestjs/common";
import { FactoryModule } from "../factory/factory.module.js";
import { ProjectController } from "./project.controller.js";
import { ProjectRepository } from "./project.repository.js";
import { ProjectService } from "./project.service.js";

@Module({
  imports: [FactoryModule],
  controllers: [ProjectController],
  providers: [ProjectRepository, ProjectService],
  exports: [ProjectService],
})
export class ProjectModule {}
