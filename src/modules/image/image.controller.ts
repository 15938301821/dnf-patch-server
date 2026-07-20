import { Body, Controller, Param, Post } from "@nestjs/common";
import { idSchema } from "../../common/contracts/index.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import {
  createImageAttemptSchema,
  type CreateImageAttemptInput,
  type ImageAttemptView,
} from "./image.contracts.js";
import { ImageService } from "./image.service.js";

@Controller("runs/:runId/image-attempts")
export class ImageController {
  constructor(private readonly images: ImageService) {}

  @Post()
  create(
    @Param("runId", new ZodValidationPipe(idSchema)) runId: string,
    @Body(new ZodValidationPipe(createImageAttemptSchema))
    input: CreateImageAttemptInput,
  ): Promise<ImageAttemptView> {
    return this.images.create(runId, input);
  }
}
