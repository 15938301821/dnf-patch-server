/**
 * @fileoverview 持久化职业、技能事实、主题定义和技能目录快照；不编排 Run、模型或本机工具。
 * @module profession
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端业务与后端工作流直接需求）
 */
import { Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../../common/db/database.service.js";
import {
  professionSkills,
  professionStyles,
  professionStyleSkills,
  professions,
  styleSkillProductions,
} from "../../common/db/studio-schema.js";
import type {
  CreateProfessionInput,
  ProfessionRecord,
  ProfessionSkillSummary,
  ProfessionStyle,
  ProfessionSummary,
  SaveProfessionStyleInput,
  StyleBuildContext,
  VerifiedProfessionSkillRecord,
} from "./profession.contracts.js";
import {
  toProfessionRecord,
  toProfessionSummary,
  toSkillSummary,
  toStyle,
} from "./profession.mapper.js";

@Injectable()
export class ProfessionRepository {
  constructor(private readonly connection: DatabaseService) {}

  async list(): Promise<ProfessionSummary[]> {
    const [professionRows, styleRows] = await Promise.all([
      this.connection.database
        .select()
        .from(professions)
        .orderBy(desc(professions.updatedAt)),
      this.connection.database
        .select({ professionId: professionStyles.professionId })
        .from(professionStyles),
    ]);
    const styleCounts = new Map<string, number>();
    for (const style of styleRows) {
      styleCounts.set(
        style.professionId,
        (styleCounts.get(style.professionId) ?? 0) + 1,
      );
    }
    return professionRows.map((row) =>
      toProfessionSummary(row, styleCounts.get(row.id) ?? 0),
    );
  }

  async findById(id: string): Promise<ProfessionRecord | undefined> {
    const [row] = await this.connection.database
      .select()
      .from(professions)
      .where(eq(professions.id, id))
      .limit(1);
    if (!row) return undefined;
    const [styleCount] = await this.connection.database
      .select({ value: count() })
      .from(professionStyles)
      .where(eq(professionStyles.professionId, id));
    return toProfessionRecord(row, styleCount?.value ?? 0);
  }

  async findByCanonicalName(
    canonicalName: string,
  ): Promise<ProfessionRecord | undefined> {
    const [row] = await this.connection.database
      .select()
      .from(professions)
      .where(eq(professions.canonicalName, canonicalName))
      .limit(1);
    return row ? toProfessionRecord(row, 0) : undefined;
  }

  async create(
    id: string,
    canonicalName: string,
    input: CreateProfessionInput,
  ): Promise<ProfessionSummary> {
    const now = new Date();
    await this.connection.database.insert(professions).values({
      id,
      name: input.name,
      slug: input.slug,
      canonicalName,
      publishStatus: "private",
      createdAt: now,
      updatedAt: now,
    });
    return {
      id,
      name: input.name,
      slug: input.slug,
      styleCount: 0,
      publishStatus: "private",
      updatedAt: now.toISOString(),
    };
  }

  async listSkills(professionId: string): Promise<ProfessionSkillSummary[]> {
    const rows = await this.connection.database
      .select()
      .from(professionSkills)
      .where(eq(professionSkills.professionId, professionId))
      .orderBy(asc(professionSkills.displayName));
    return rows.map(toSkillSummary);
  }

  async findSkillsByIds(
    professionId: string,
    skillIds: string[],
  ): Promise<ProfessionSkillSummary[]> {
    if (skillIds.length === 0) return [];
    const rows = await this.connection.database
      .select()
      .from(professionSkills)
      .where(
        and(
          eq(professionSkills.professionId, professionId),
          inArray(professionSkills.id, skillIds),
        ),
      );
    return rows.map(toSkillSummary);
  }

  async listStyles(professionId: string): Promise<ProfessionStyle[]> {
    const styleRows = await this.connection.database
      .select()
      .from(professionStyles)
      .where(eq(professionStyles.professionId, professionId))
      .orderBy(desc(professionStyles.updatedAt));
    if (styleRows.length === 0) return [];
    const selectionRows = await this.connection.database
      .select()
      .from(professionStyleSkills)
      .where(
        inArray(
          professionStyleSkills.styleId,
          styleRows.map((style) => style.id),
        ),
      )
      .orderBy(asc(professionStyleSkills.ordinal));
    const selections = new Map<string, string[]>();
    for (const selection of selectionRows) {
      const skillIds = selections.get(selection.styleId) ?? [];
      skillIds.push(selection.skillId);
      selections.set(selection.styleId, skillIds);
    }
    return styleRows.map((row) => toStyle(row, selections.get(row.id) ?? []));
  }

  async findStyle(
    professionId: string,
    styleId: string,
  ): Promise<ProfessionStyle | undefined> {
    return (await this.listStyles(professionId)).find(
      (style) => style.id === styleId,
    );
  }

  async createStyle(
    professionId: string,
    styleId: string,
    canonicalName: string,
    input: SaveProfessionStyleInput,
  ): Promise<ProfessionStyle> {
    const now = new Date();
    await this.connection.database.transaction(async (transaction) => {
      await transaction.insert(professionStyles).values({
        id: styleId,
        professionId,
        name: input.name,
        canonicalName,
        description: input.description,
        agent: input.agent,
        prompt: input.prompt,
        publishStatus: "private",
        createdAt: now,
        updatedAt: now,
      });
      await transaction.insert(professionStyleSkills).values(
        input.selectedSkillIds.map((skillId, ordinal) => ({
          professionId,
          styleId,
          skillId,
          ordinal,
          createdAt: now,
          updatedAt: now,
        })),
      );
      await transaction
        .update(professions)
        .set({ updatedAt: now })
        .where(eq(professions.id, professionId));
    });
    return toStyle(
      {
        id: styleId,
        professionId,
        name: input.name,
        canonicalName,
        description: input.description,
        agent: input.agent,
        prompt: input.prompt,
        publishStatus: "private",
        createdAt: now,
        updatedAt: now,
      },
      input.selectedSkillIds,
    );
  }

  async updateStyle(
    professionId: string,
    styleId: string,
    canonicalName: string,
    input: SaveProfessionStyleInput,
  ): Promise<ProfessionStyle> {
    const now = new Date();
    await this.connection.database.transaction(async (transaction) => {
      await transaction
        .update(professionStyles)
        .set({
          name: input.name,
          canonicalName,
          description: input.description,
          agent: input.agent,
          prompt: input.prompt,
          publishStatus: "private",
          updatedAt: now,
        })
        .where(
          and(
            eq(professionStyles.professionId, professionId),
            eq(professionStyles.id, styleId),
          ),
        );
      await transaction
        .delete(professionStyleSkills)
        .where(eq(professionStyleSkills.styleId, styleId));
      await transaction.insert(professionStyleSkills).values(
        input.selectedSkillIds.map((skillId, ordinal) => ({
          professionId,
          styleId,
          skillId,
          ordinal,
          createdAt: now,
          updatedAt: now,
        })),
      );
    });
    return {
      id: styleId,
      professionId,
      ...input,
      publishStatus: "private",
      updatedAt: now.toISOString(),
    };
  }

  async hasProduction(styleId: string): Promise<boolean> {
    const [row] = await this.connection.database
      .select({ id: styleSkillProductions.id })
      .from(styleSkillProductions)
      .where(eq(styleSkillProductions.styleId, styleId))
      .limit(1);
    return row !== undefined;
  }

  async submitStyleForReview(
    professionId: string,
    styleId: string,
  ): Promise<ProfessionStyle | undefined> {
    const now = new Date();
    await this.connection.database
      .update(professionStyles)
      .set({ publishStatus: "pending", updatedAt: now })
      .where(
        and(
          eq(professionStyles.professionId, professionId),
          eq(professionStyles.id, styleId),
        ),
      );
    return this.findStyle(professionId, styleId);
  }

  async replaceSkillCatalog(
    professionId: string,
    workflowProjectId: string,
    catalogSnapshotId: string,
    skills: VerifiedProfessionSkillRecord[],
  ): Promise<ProfessionSkillSummary[]> {
    const now = new Date();
    await this.connection.database.transaction(async (transaction) => {
      await transaction
        .update(professions)
        .set({ workflowProjectId, catalogSnapshotId, updatedAt: now })
        .where(eq(professions.id, professionId));
      await transaction
        .update(professionSkills)
        .set({
          mappingStatus: "unverified",
          executionStatus: "draft-only",
          sourceRunId: null,
          sourceInventoryId: null,
          sourceInventoryEntryId: null,
          sourceFrameManifestArtifactId: null,
          sourceMetadataSha256: null,
          updatedAt: now,
        })
        .where(eq(professionSkills.professionId, professionId));
      const existing = await transaction
        .select()
        .from(professionSkills)
        .where(eq(professionSkills.professionId, professionId));
      const byStableKey = new Map(
        existing.map((skill) => [skill.stableKey, skill]),
      );
      for (const skill of skills) {
        const current = byStableKey.get(skill.stableKey);
        const values = {
          displayName: skill.displayName,
          promptStatus: skill.promptStatus,
          mappingStatus: "verified" as const,
          executionStatus: "build-ready" as const,
          sourceRunId: skill.sourceRunId,
          sourceInventoryId: skill.sourceInventoryId,
          sourceInventoryEntryId: skill.sourceInventoryEntryId,
          sourceFrameManifestArtifactId: skill.sourceFrameManifestArtifactId,
          sourceMetadataSha256: skill.sourceMetadataSha256.toUpperCase(),
          updatedAt: now,
        };
        if (current) {
          await transaction
            .update(professionSkills)
            .set(values)
            .where(eq(professionSkills.id, current.id));
        } else {
          await transaction.insert(professionSkills).values({
            id: randomUUID(),
            professionId,
            stableKey: skill.stableKey,
            ...values,
            createdAt: now,
          });
        }
      }
    });
    return this.listSkills(professionId);
  }

  async getBuildContext(
    professionId: string,
    styleId: string,
  ): Promise<StyleBuildContext | undefined> {
    const profession = await this.findById(professionId);
    const style = await this.findStyle(professionId, styleId);
    if (!profession || !style) return undefined;
    const rows = await this.connection.database
      .select()
      .from(professionSkills)
      .where(
        and(
          eq(professionSkills.professionId, professionId),
          inArray(professionSkills.id, style.selectedSkillIds),
        ),
      );
    const skillsById = new Map(rows.map((skill) => [skill.id, skill]));
    const skills = style.selectedSkillIds.map((skillId) =>
      skillsById.get(skillId),
    );
    if (skills.some((skill) => skill === undefined)) return undefined;
    return {
      profession,
      style,
      skills: skills.map((skill) => {
        if (
          !skill ||
          skill.executionStatus !== "build-ready" ||
          !skill.sourceRunId ||
          !skill.sourceFrameManifestArtifactId ||
          !skill.sourceMetadataSha256
        ) {
          throw new Error("STYLE_SKILL_NOT_BUILD_READY");
        }
        return {
          ...toSkillSummary(skill),
          sourceRunId: skill.sourceRunId,
          sourceFrameManifestArtifactId: skill.sourceFrameManifestArtifactId,
          sourceMetadataSha256: skill.sourceMetadataSha256,
        };
      }),
    };
  }
}
