/**
 * @fileoverview 在职业目录事务中替换并读取技能的有序 Inventory Entry 来源集合。
 * @module profession
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 真实 momentaryslash 多 IMG 证据绑定
 *
 * 调用关系：ProfessionRepository 委托本模块执行技能目录原子替换及生产上下文来源读取。
 * 输入是 Service 已逐条核验的 DTO；输出只含 Entry ID 与权威元数据哈希，不返回内部路径或正文。
 * 安全边界：旧来源必须先删除再降级父技能；新父技能与全部子来源必须在同一事务提交，缺少来源时
 * 生产上下文继续阻断。数据库复合外键负责防止跨技能、跨 Inventory 或悬空 Entry 关联。
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DatabaseService } from "../../common/db/database.service.js";
import { professionSkillSourceEntries } from "../../common/db/profession-source-schema.js";
import { npkInventoryEntries } from "../../common/db/schema.js";
import {
  professionSkills,
  professions,
} from "../../common/db/studio-schema.js";
import { sha256JcsV1 } from "../../common/utils/canonical.js";
import type {
  ImportProfessionSkillInput,
  VerifiedProfessionSkillRecord,
} from "./profession.contracts.js";

type ProfessionTransaction = Parameters<
  Parameters<DatabaseService["database"]["transaction"]>[0]
>[0];

/** 在同一事务中降级旧目录并写入每个技能完整、非空且有序的来源集合。 */
export async function replaceProfessionSkillCatalog(
  transaction: ProfessionTransaction,
  professionId: string,
  workflowProjectId: string,
  catalogSnapshotId: string,
  skills: VerifiedProfessionSkillRecord[],
  now: Date,
): Promise<void> {
  await transaction
    .delete(professionSkillSourceEntries)
    .where(eq(professionSkillSourceEntries.professionId, professionId));
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
      professionPrompt: null,
      professionPromptSha256: null,
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
    const primarySource = skill.sourceEntries[0];
    if (!primarySource) throw new Error("SKILL_SOURCE_ENTRIES_REQUIRED");
    const current = byStableKey.get(skill.stableKey);
    const skillId = current?.id ?? randomUUID();
    const professionPromptSha256 = skill.professionPrompt
      ? sha256JcsV1(skill.professionPrompt)
      : null;
    const values = {
      displayName: skill.displayName,
      promptStatus: skill.promptStatus,
      mappingStatus: "verified" as const,
      executionStatus: skill.professionPrompt
        ? ("build-ready" as const)
        : ("draft-only" as const),
      sourceRunId: skill.sourceRunId,
      sourceInventoryId: skill.sourceInventoryId,
      sourceInventoryEntryId: primarySource.sourceInventoryEntryId,
      sourceFrameManifestArtifactId: skill.sourceFrameManifestArtifactId,
      sourceMetadataSha256: primarySource.sourceMetadataSha256.toUpperCase(),
      professionPrompt: skill.professionPrompt ?? null,
      professionPromptSha256,
      updatedAt: now,
    };
    if (current) {
      await transaction
        .update(professionSkills)
        .set(values)
        .where(eq(professionSkills.id, skillId));
    } else {
      await transaction.insert(professionSkills).values({
        id: skillId,
        professionId,
        stableKey: skill.stableKey,
        ...values,
        createdAt: now,
      });
    }
    await transaction.insert(professionSkillSourceEntries).values(
      skill.sourceEntries.map((source, ordinal) => ({
        professionId,
        skillId,
        sourceInventoryId: skill.sourceInventoryId,
        sourceInventoryEntryId: source.sourceInventoryEntryId,
        ordinal,
      })),
    );
  }
}

/** 读取选中技能的权威 Entry 哈希，并按目录冻结的 ordinal 恢复每个来源集合。 */
export async function readProfessionSkillSources(
  database: DatabaseService["database"],
  skillIds: string[],
): Promise<Map<string, ImportProfessionSkillInput["sourceEntries"]>> {
  const result = new Map<string, ImportProfessionSkillInput["sourceEntries"]>();
  if (skillIds.length === 0) return result;
  const rows = await database
    .select({
      skillId: professionSkillSourceEntries.skillId,
      sourceInventoryEntryId:
        professionSkillSourceEntries.sourceInventoryEntryId,
      sourceMetadataSha256: npkInventoryEntries.metadataSha256,
      ordinal: professionSkillSourceEntries.ordinal,
    })
    .from(professionSkillSourceEntries)
    .innerJoin(
      npkInventoryEntries,
      and(
        eq(
          professionSkillSourceEntries.sourceInventoryId,
          npkInventoryEntries.inventoryId,
        ),
        eq(
          professionSkillSourceEntries.sourceInventoryEntryId,
          npkInventoryEntries.id,
        ),
      ),
    )
    .where(inArray(professionSkillSourceEntries.skillId, skillIds))
    .orderBy(asc(professionSkillSourceEntries.ordinal));
  for (const row of rows) {
    const sources = result.get(row.skillId) ?? [];
    sources.push({
      sourceInventoryEntryId: row.sourceInventoryEntryId,
      sourceMetadataSha256: row.sourceMetadataSha256,
    });
    result.set(row.skillId, sources);
  }
  return result;
}
