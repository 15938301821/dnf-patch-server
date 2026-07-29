/**
 * @fileoverview 暴露浏览器职业/主题创建、保存、删除、审核 API 和仅 Worker 可用的技能目录导入 API。
 * @module profession
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端业务与后端工作流直接需求）
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { idSchema } from "../../common/contracts/index.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { WorkerTokenGuard } from "../../common/security/worker-token.guard.js";
import { AuthService } from "../auth/auth.service.js";
import {
  bindProfessionCatalogContextSchema,
  createProfessionSchema,
  importProfessionSkillCatalogSchema,
  saveProfessionStyleSchema,
  type BindProfessionCatalogContextInput,
  type CreateProfessionInput,
  type ImportProfessionSkillCatalogInput,
  type ProfessionCatalogContextView,
  type ProfessionCatalogImportView,
  type ProfessionSkillSummary,
  type ProfessionStyle,
  type ProfessionSummary,
  type SaveProfessionStyleInput,
} from "./profession.contracts.js";
import { ProfessionService } from "./profession.service.js";

@Controller("professions")
export class ProfessionController {
  constructor(
    private readonly professions: ProfessionService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  async list(
    @Headers("authorization") authorization: string | undefined,
  ): Promise<{ data: ProfessionSummary[] }> {
    const user = await this.auth.requireBrowserUser(authorization);
    return { data: await this.professions.list(user.id) };
  }

  @Post()
  async create(
    @Headers("authorization") authorization: string | undefined,
    @Body(new ZodValidationPipe(createProfessionSchema))
    input: CreateProfessionInput,
  ): Promise<{ data: ProfessionSummary }> {
    const user = await this.auth.requireBrowserUser(authorization);
    return { data: await this.professions.create(input, user.id) };
  }

  /**
   * 删除当前用户拥有的空职业。
   * @param authorization 浏览器 Bearer Access Token；认证不替代 Service/Repository 所有权检查。
   * @param professionId path 中经 UUID schema 校验的职业 ID。
   * @returns 204 无正文；不会级联删除技能、风格、任务或资源证据。
   * @throws PROFESSION_DELETE_NOT_ALLOWED 当职业状态或内容受保护时返回 409。
   */
  @Delete(":professionId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Headers("authorization") authorization: string | undefined,
    @Param("professionId", new ZodValidationPipe(idSchema))
    professionId: string,
  ): Promise<void> {
    const user = await this.auth.requireBrowserUser(authorization);
    await this.professions.delete(professionId, user.id);
  }

  @Get(":professionId/skills")
  async listSkills(
    @Headers("authorization") authorization: string | undefined,
    @Param("professionId", new ZodValidationPipe(idSchema))
    professionId: string,
  ): Promise<{ data: ProfessionSkillSummary[] }> {
    const user = await this.auth.requireBrowserUser(authorization);
    return {
      data: await this.professions.listSkills(professionId, user.id),
    };
  }

  @Get(":professionId/styles")
  async listStyles(
    @Headers("authorization") authorization: string | undefined,
    @Param("professionId", new ZodValidationPipe(idSchema))
    professionId: string,
  ): Promise<{ data: ProfessionStyle[] }> {
    const user = await this.auth.requireBrowserUser(authorization);
    return {
      data: await this.professions.listStyles(professionId, user.id),
    };
  }

  @Post(":professionId/styles")
  async createStyle(
    @Headers("authorization") authorization: string | undefined,
    @Param("professionId", new ZodValidationPipe(idSchema))
    professionId: string,
    @Body(new ZodValidationPipe(saveProfessionStyleSchema))
    input: SaveProfessionStyleInput,
  ): Promise<{ data: ProfessionStyle }> {
    const user = await this.auth.requireBrowserUser(authorization);
    return {
      data: await this.professions.createStyle(professionId, input, user.id),
    };
  }

  @Put(":professionId/styles/:styleId")
  async updateStyle(
    @Headers("authorization") authorization: string | undefined,
    @Param("professionId", new ZodValidationPipe(idSchema))
    professionId: string,
    @Param("styleId", new ZodValidationPipe(idSchema)) styleId: string,
    @Body(new ZodValidationPipe(saveProfessionStyleSchema))
    input: SaveProfessionStyleInput,
  ): Promise<{ data: ProfessionStyle }> {
    const user = await this.auth.requireBrowserUser(authorization);
    return {
      data: await this.professions.updateStyle(
        professionId,
        styleId,
        input,
        user.id,
      ),
    };
  }

  /**
   * 删除当前用户拥有的、尚未进入生产链的私有或被驳回风格草稿。
   *
   * @param authorization 浏览器 Bearer Access Token；AuthService 解析稳定用户身份，不能由请求体提供。
   * @param professionId 路径中的职业 UUID，先由 Zod 校验，再由 Service 复核所有权。
   * @param styleId 路径中的风格 UUID，必须属于同一职业且没有生产证据引用。
   * @returns 204 无正文；成功只表示风格及其编辑子行已删除，不影响其他职业或任务证据。
   * @throws STYLE_DELETE_NOT_ALLOWED 当风格已送审/发布，或已有生产记录时返回 409。
   */
  @Delete(":professionId/styles/:styleId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteStyle(
    @Headers("authorization") authorization: string | undefined,
    @Param("professionId", new ZodValidationPipe(idSchema))
    professionId: string,
    @Param("styleId", new ZodValidationPipe(idSchema)) styleId: string,
  ): Promise<void> {
    const user = await this.auth.requireBrowserUser(authorization);
    await this.professions.deleteStyle(professionId, styleId, user.id);
  }

  @Post(":professionId/styles/:styleId/review")
  async submitStyleForReview(
    @Headers("authorization") authorization: string | undefined,
    @Param("professionId", new ZodValidationPipe(idSchema))
    professionId: string,
    @Param("styleId", new ZodValidationPipe(idSchema)) styleId: string,
  ): Promise<{ data: ProfessionStyle }> {
    const user = await this.auth.requireBrowserUser(authorization);
    return {
      data: await this.professions.submitStyleForReview(
        professionId,
        styleId,
        user.id,
      ),
    };
  }
}

@Controller("internal/professions")
@UseGuards(WorkerTokenGuard)
export class ProfessionCatalogController {
  constructor(private readonly professions: ProfessionService) {}

  /**
   * 绑定职业目录的已登记 Project/Snapshot 上下文，同时把技能证据降级为未核验。
   * Worker token 只完成调用身份认证；Project/Snapshot 归属与改绑冲突仍由 Service 校验。
   */
  @Put(":professionId/catalog-context")
  bindCatalogContext(
    @Param("professionId", new ZodValidationPipe(idSchema))
    professionId: string,
    @Body(new ZodValidationPipe(bindProfessionCatalogContextSchema))
    input: BindProfessionCatalogContextInput,
  ): Promise<ProfessionCatalogContextView> {
    return this.professions.bindCatalogContext(professionId, input);
  }

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
