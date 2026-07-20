import { Module } from "@nestjs/common";
import { RunModule } from "../run/run.module.js";
import { OpenAiProvider } from "./openai.provider.js";
import { OpenAiRecoveryService } from "./openai-recovery.service.js";
import { OpenAiRepository } from "./openai.repository.js";
import { OpenAiService } from "./openai.service.js";

@Module({
  imports: [RunModule],
  providers: [
    OpenAiProvider,
    OpenAiRepository,
    OpenAiRecoveryService,
    OpenAiService,
  ],
  exports: [OpenAiService],
})
export class OpenAiModule {}
