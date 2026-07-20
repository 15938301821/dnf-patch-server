import { Module } from "@nestjs/common";
import { RunModule } from "../run/run.module.js";
import { ImageController } from "./image.controller.js";
import { ImageRepository } from "./image.repository.js";
import { ImageService } from "./image.service.js";

@Module({
  imports: [RunModule],
  controllers: [ImageController],
  providers: [ImageRepository, ImageService],
  exports: [ImageService],
})
export class ImageModule {}
