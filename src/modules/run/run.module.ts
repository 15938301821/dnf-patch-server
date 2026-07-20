import { Module } from "@nestjs/common";
import { GuardrailModule } from "../guardrail/guardrail.module.js";
import { RunController } from "./run.controller.js";
import { RunGateway } from "./run.gateway.js";
import { RunRepository } from "./run.repository.js";
import { RunService } from "./run.service.js";

@Module({
  imports: [GuardrailModule],
  controllers: [RunController],
  providers: [RunRepository, RunService, RunGateway],
  exports: [RunService, RunGateway],
})
export class RunModule {}
