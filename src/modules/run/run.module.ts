import { Module } from "@nestjs/common";
import { FactoryModule } from "../factory/factory.module.js";
import { GuardrailModule } from "../guardrail/guardrail.module.js";
import { ProjectModule } from "../project/project.module.js";
import { RunController } from "./run.controller.js";
import { RunGateway } from "./run.gateway.js";
import { RunOutboxDispatcherService } from "./run-outbox-dispatcher.service.js";
import { RunOutboxRepository } from "./run-outbox.repository.js";
import { RunRepository } from "./run.repository.js";
import { RunService } from "./run.service.js";

@Module({
  imports: [GuardrailModule, FactoryModule, ProjectModule],
  controllers: [RunController],
  providers: [
    RunRepository,
    RunService,
    RunGateway,
    RunOutboxRepository,
    RunOutboxDispatcherService,
  ],
  exports: [RunService, RunGateway],
})
export class RunModule {}
