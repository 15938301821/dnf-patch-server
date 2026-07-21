import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { ModelCredentialCipher } from "./model-credential-cipher.js";
import { ModelConfigurationController } from "./model-configuration.controller.js";
import { ModelConfigurationRepository } from "./model-configuration.repository.js";
import { ModelConfigurationService } from "./model-configuration.service.js";

@Module({
  imports: [AuthModule],
  controllers: [ModelConfigurationController],
  providers: [
    ModelCredentialCipher,
    ModelConfigurationRepository,
    ModelConfigurationService,
  ],
  exports: [ModelConfigurationService],
})
export class ModelConfigurationModule {}
