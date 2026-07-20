import { Body, Controller, Post } from "@nestjs/common";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import {
  frameGuardrailSchema,
  type FrameGuardrailInput,
  type FrameGuardrailResult,
} from "./frame-guardrail.contracts.js";
import { FrameGuardrailService } from "./frame-guardrail.service.js";

@Controller("guardrails")
export class GuardrailController {
  constructor(private readonly frames: FrameGuardrailService) {}

  @Post("frame-invariants")
  evaluateFrame(
    @Body(new ZodValidationPipe(frameGuardrailSchema))
    input: FrameGuardrailInput,
  ): Promise<FrameGuardrailResult> {
    return this.frames.evaluate(input);
  }
}
