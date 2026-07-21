/**
 * @fileoverview 暴露浏览器职业/主题 API 和仅 Worker 可用的技能目录导入 API。
 * @module profession
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端业务与后端工作流直接需求）
 */
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { idSchema } from "../../common/contracts/index.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { WorkerTokenGuard } from "../../common/security/worker-token.guard.js";
import {
  createProfessionSchema,
  importProfessionSkillCatalogSchema,
  saveProfessionStyleSchema,
  type CreateProfessionInput,
  type ImportProfessionSkillCatalogInput,
  type ProfessionCatalogImportView,
  type ProfessionSkillSummary,
  type ProfessionStyle,
  type ProfessionSummary,
  type SaveProfessionStyleInput,
} from "./profession.contracts.js";
import { ProfessionService } from "./profession.service.js";

@Controller("professions")
export class ProfessionController {
  constructor(private readonly professions: ProfessionService) {}

  @Get()
  async list(): Promise<{ data: ProfessionSummary[] }> {
    return { data: await this.professions.list() };
  }

  @Post()
  async create(
    @Body(new ZodValidationPipe(createProfessionSchema))
    input: CreateProfessionInput,
  ): Promise<{ data: ProfessionSummary }> {
    return { data: await this.professions.create(input) };
  }

  @Get(":professionId/skills")
  async listSkills(
    @Param("professionId", new ZodValidationPipe(idSchema))
    professionId: string,
  ): Promise<{ data: ProfessionSkillSummary[] }> {
    return { data: await this.professions.listSkills(professionId) };
  }

  @Get(":professionId/styles")
  async listStyles(
    @Param("professionId", new ZodValidationPipe(idSchema))
    professionId: string,
  ): Promise<{ data: ProfessionStyle[] }> {
    return { data: await this.professions.listStyles(professionId) };
  }

  @Post(":professionId/styles")
  async createStyle(
    @Param("professionId", new ZodValidationPipe(idSchema))
    professionId: string,
    @Body(new ZodValidationPipe(saveProfessionStyleSchema))
    input: SaveProfessionStyleInput,
  ): Promise<{ data: ProfessionStyle }> {
    return { data: await this.professions.createStyle(professionId, input) };
  }

  @Put(":professionId/styles/:styleId")
  async updateStyle(
    @Param("professionId", new ZodValidationPipe(idSchema))
    professionId: string,
    @Param("styleId", new ZodValidationPipe(idSchema)) styleId: string,
    @Body(new ZodValidationPipe(saveProfessionStyleSchema))
    input: SaveProfessionStyleInput,
  ): Promise<{ data: ProfessionStyle }> {
    return {
      data: await this.professions.updateStyle(professionId, styleId, input),
    };
  }

  @Post(":professionId/styles/:styleId/review")
  async submitStyleForReview(
    @Param("professionId", new ZodValidationPipe(idSchema))
    professionId: string,
    @Param("styleId", new ZodValidationPipe(idSchema)) styleId: string,
  ): Promise<{ data: ProfessionStyle }> {
    return {
      data: await this.professions.submitStyleForReview(professionId, styleId),
    };
  }
}

@Controller("internal/professions")
@UseGuards(WorkerTokenGuard)
export class ProfessionCatalogController {
  constructor(private readonly professions: ProfessionService) {}

  @Put(":professionId/skill-catalog")
  importSkillCatalog(
    @Param("professionId", new ZodValidationPipe(idSchema))
    professionId: string,
    @Body(new ZodValidationPipe(importProfessionSkillCatalogSchema))
    input: ImportProfessionSkillCatalogInput,
  ): Promise<ProfessionCatalogImportView> {
    return this.professions.importSkillCatalog(professionId, input);
  }
}
