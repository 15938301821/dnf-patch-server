import { Module } from "@nestjs/common";
import { ModelConfigurationController } from "./model-configuration.controller.js";
import { ModelConfigurationService } from "./model-configuration.service.js";

@Module({
  controllers: [ModelConfigurationController],
  providers: [ModelConfigurationService],
})
export class ModelConfigurationModule {}
