import { Module } from "@nestjs/common";
import { FrameGuardrailService } from "./frame-guardrail.service.js";
import { GuardrailController } from "./guardrail.controller.js";
import { GuardrailService } from "./guardrail.service.js";

@Module({
  controllers: [GuardrailController],
  providers: [GuardrailService, FrameGuardrailService],
  exports: [GuardrailService, FrameGuardrailService],
})
export class GuardrailModule {}
