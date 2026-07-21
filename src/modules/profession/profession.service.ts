/**
 * @fileoverview 编排职业、主题和已核验技能目录，校验证据归属；不读取游戏目录或执行图片工具。
 * @module profession
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端业务与后端工作流直接需求）
 */
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { isMysqlDuplicateEntry } from "../../common/db/mysql-errors.js";
import { canonicalName } from "../../common/utils/canonical.js";
import { ArtifactService } from "../artifact/artifact.service.js";
import { NpkService } from "../npk/npk.service.js";
import { ProjectService } from "../project/project.service.js";
import { RunService } from "../run/run.service.js";
import type {
  CreateProfessionInput,
  ImportProfessionSkillCatalogInput,
  ProfessionCatalogImportView,
  ProfessionRecord,
  ProfessionSkillSummary,
  ProfessionStyle,
  ProfessionSummary,
  SaveProfessionStyleInput,
  StyleBuildContext,
  VerifiedProfessionSkillRecord,
} from "./profession.contracts.js";
import { ProfessionRepository } from "./profession.repository.js";

@Injectable()
export class ProfessionService {
  constructor(
    private readonly professions: ProfessionRepository,
    private readonly projects: ProjectService,
    private readonly runs: RunService,
    private readonly inventories: NpkService,
    private readonly artifacts: ArtifactService,
  ) {}

  list(): Promise<ProfessionSummary[]> {
    return this.professions.list();
  }

  async get(id: string): Promise<ProfessionRecord> {
    const profession = await this.professions.findById(id);
    if (!profession) {
      throw new NotFoundException({
        code: "PROFESSION_NOT_FOUND",
        message: "职业不存在。",
      });
    }
    return profession;
  }

  async create(input: CreateProfessionInput): Promise<ProfessionSummary> {
    const normalizedName = canonicalName(input.name);
    if (await this.professions.findByCanonicalName(normalizedName)) {
      throw new ConflictException({
        code: "PROFESSION_NAME_CONFLICT",
        message: "规范化后的职业名称已存在。",
      });
    }
    try {
      return await this.professions.create(randomUUID(), normalizedName, input);
    } catch (error) {
      if (isMysqlDuplicateEntry(error)) {
        throw new ConflictException({
          code: "PROFESSION_IDENTITY_CONFLICT",
          message: "职业名称或 slug 已存在。",
        });
      }
      throw error;
    }
  }

  async listSkills(professionId: string): Promise<ProfessionSkillSummary[]> {
    await this.get(professionId);
    return this.professions.listSkills(professionId);
  }

  async listStyles(professionId: string): Promise<ProfessionStyle[]> {
    await this.get(professionId);
    return this.professions.listStyles(professionId);
  }

  async createStyle(
    professionId: string,
    input: SaveProfessionStyleInput,
  ): Promise<ProfessionStyle> {
    await this.get(professionId);
    await this.assertSelectedSkills(professionId, input.selectedSkillIds);
    try {
      return await this.professions.createStyle(
        professionId,
        randomUUID(),
        canonicalName(input.name),
        input,
      );
    } catch (error) {
      if (isMysqlDuplicateEntry(error)) {
        throw new ConflictException({
          code: "STYLE_NAME_CONFLICT",
          message: "当前职业已存在同名主题。",
        });
      }
      throw error;
    }
  }

  async updateStyle(
    professionId: string,
    styleId: string,
    input: SaveProfessionStyleInput,
  ): Promise<ProfessionStyle> {
    await this.requireStyle(professionId, styleId);
    if (await this.professions.hasProduction(styleId)) {
      throw new ConflictException({
        code: "STYLE_PRODUCTION_ALREADY_STARTED",
        message: "主题已有生产记录，不能再修改技能范围。",
      });
    }
    await this.assertSelectedSkills(professionId, input.selectedSkillIds);
    try {
      return await this.professions.updateStyle(
        professionId,
        styleId,
        canonicalName(input.name),
        input,
      );
    } catch (error) {
      if (isMysqlDuplicateEntry(error)) {
        throw new ConflictException({
          code: "STYLE_NAME_CONFLICT",
          message: "当前职业已存在同名主题。",
        });
      }
      throw error;
    }
  }

  async submitStyleForReview(
    professionId: string,
    styleId: string,
  ): Promise<ProfessionStyle> {
    await this.requireStyle(professionId, styleId);
    const style = await this.professions.submitStyleForReview(
      professionId,
      styleId,
    );
    if (!style) throw new Error("STYLE_REVIEW_STATE_CONFLICT");
    return style;
  }

  async getStyleBuildContext(
    professionId: string,
    styleId: string,
  ): Promise<StyleBuildContext> {
    const context = await this.professions.getBuildContext(
      professionId,
      styleId,
    );
    if (!context) {
      throw new NotFoundException({
        code: "STYLE_NOT_FOUND",
        message: "职业主题不存在或技能目录不完整。",
      });
    }
    if (!context.profession.workflowProjectId) {
      throw new ConflictException({
        code: "PROFESSION_WORKFLOW_PROJECT_REQUIRED",
        message: "职业尚未绑定已核验资源项目，不能创建制作任务。",
      });
    }
    if (context.skills.length !== context.style.selectedSkillIds.length) {
      throw new ConflictException({
        code: "STYLE_SKILLS_NOT_BUILD_READY",
        message: "主题技能范围缺少可执行的核验证据。",
      });
    }
    return context;
  }

  /**
   * 只有同一 Project/Snapshot/Run 的 Inventory Entry 与帧清单证据齐备时，技能才会进入 build-ready。
   */
  async importSkillCatalog(
    professionId: string,
    input: ImportProfessionSkillCatalogInput,
  ): Promise<ProfessionCatalogImportView> {
    const profession = await this.get(professionId);
    if (
      profession.workflowProjectId &&
      profession.workflowProjectId !== input.workflowProjectId
    ) {
      throw new ConflictException({
        code: "PROFESSION_PROJECT_BINDING_CONFLICT",
        message: "职业已绑定到其他工作流项目。",
      });
    }
    await this.projects.get(input.workflowProjectId);
    await this.projects.getSnapshot(
      input.workflowProjectId,
      input.catalogSnapshotId,
    );
    const run = await this.runs.get(input.sourceRunId);
    if (
      run.projectId !== input.workflowProjectId ||
      run.snapshotId !== input.catalogSnapshotId
    ) {
      throw new ConflictException({
        code: "SKILL_CATALOG_RUN_SNAPSHOT_MISMATCH",
        message: "技能目录 Run 不属于目标项目快照。",
      });
    }
    const verified: VerifiedProfessionSkillRecord[] = [];
    for (const skill of input.skills) {
      const entry = await this.inventories.getEntryEvidence(
        skill.sourceInventoryId,
        skill.sourceInventoryEntryId,
      );
      if (
        entry.projectId !== input.workflowProjectId ||
        entry.runId !== input.sourceRunId ||
        entry.metadataSha256.toUpperCase() !==
          skill.sourceMetadataSha256.toUpperCase()
      ) {
        throw new ConflictException({
          code: "SKILL_RESOURCE_EVIDENCE_MISMATCH",
          message: "技能资源证据与目标项目、Run 或元数据哈希不一致。",
        });
      }
      const artifactRunId = await this.artifacts.findRunId(
        skill.sourceFrameManifestArtifactId,
      );
      if (artifactRunId !== input.sourceRunId) {
        throw new ConflictException({
          code: "SKILL_FRAME_MANIFEST_RUN_MISMATCH",
          message: "技能源帧清单不存在或不属于目录 Run。",
        });
      }
      verified.push({ ...skill, sourceRunId: input.sourceRunId });
    }
    const skills = await this.professions.replaceSkillCatalog(
      professionId,
      input.workflowProjectId,
      input.catalogSnapshotId,
      verified,
    );
    return {
      professionId,
      workflowProjectId: input.workflowProjectId,
      catalogSnapshotId: input.catalogSnapshotId,
      sourceRunId: input.sourceRunId,
      importedSkillCount: input.skills.length,
      skills,
    };
  }

  private async requireStyle(
    professionId: string,
    styleId: string,
  ): Promise<ProfessionStyle> {
    await this.get(professionId);
    const style = await this.professions.findStyle(professionId, styleId);
    if (!style) {
      throw new NotFoundException({
        code: "STYLE_NOT_FOUND",
        message: "职业主题不存在。",
      });
    }
    return style;
  }

  private async assertSelectedSkills(
    professionId: string,
    selectedSkillIds: string[],
  ): Promise<void> {
    const skills = await this.professions.findSkillsByIds(
      professionId,
      selectedSkillIds,
    );
    if (skills.length !== selectedSkillIds.length) {
      throw new ConflictException({
        code: "STYLE_SKILLS_INVALID",
        message: "主题只能选择当前职业技能目录中的稳定技能 ID。",
      });
    }
  }
}
