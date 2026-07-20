import { Module } from "@nestjs/common";
import { RunModule } from "../run/run.module.js";
import { OpenAiService } from "./openai.service.js";

@Module({
  imports: [RunModule],
  providers: [OpenAiService],
  exports: [OpenAiService],
})
export class OpenAiModule {}
