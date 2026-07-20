import { Module } from "@nestjs/common";
import { FactoryController } from "./factory.controller.js";
import { FactoryRepository } from "./factory.repository.js";
import { FactoryService } from "./factory.service.js";

@Module({
  controllers: [FactoryController],
  providers: [FactoryRepository, FactoryService],
  exports: [FactoryService],
})
export class FactoryModule {}
