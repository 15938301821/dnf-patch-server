import { Module } from "@nestjs/common";
import { NpkController } from "./npk.controller.js";
import { NpkRepository } from "./npk.repository.js";
import { NpkService } from "./npk.service.js";

@Module({
  controllers: [NpkController],
  providers: [NpkRepository, NpkService],
  exports: [NpkService],
})
export class NpkModule {}
