import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ArtifactModule } from "./modules/artifact/artifact.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { DatabaseModule } from "./common/db/database.module.js";
import { SecurityModule } from "./common/security/security.module.js";
import { validateEnvironment } from "./config/environment.js";
import { FactoryModule } from "./modules/factory/factory.module.js";
import { GuardrailModule } from "./modules/guardrail/guardrail.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { ImageModule } from "./modules/image/image.module.js";
import { JobModule } from "./modules/job/job.module.js";
import { ResourceImportModule } from "./modules/job/resource-import.module.js";
import { ModelConfigurationModule } from "./modules/model-configuration/model-configuration.module.js";
import { NpkModule } from "./modules/npk/npk.module.js";
import { OpenAiModule } from "./modules/openai/openai.module.js";
import { ProfessionModule } from "./modules/profession/profession.module.js";
import { ProjectModule } from "./modules/project/project.module.js";
import { RunModule } from "./modules/run/run.module.js";
import { WorkerModule } from "./modules/worker/worker.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
    }),
    DatabaseModule,
    SecurityModule,
    AuthModule,
    HealthModule,
    FactoryModule,
    ProjectModule,
    RunModule,
    JobModule,
    ResourceImportModule,
    ModelConfigurationModule,
    WorkerModule,
    ArtifactModule,
    NpkModule,
    ProfessionModule,
    ImageModule,
    GuardrailModule,
    OpenAiModule,
  ],
})
export class AppModule {}
