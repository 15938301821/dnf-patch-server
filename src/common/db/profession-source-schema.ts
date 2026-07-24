/**
 * @fileoverview 定义职业技能到已冻结 Inventory Entry 集合的有序关联；不复制 IMG 元数据或正文。
 * @module common/db/profession-source-schema
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 真实 momentaryslash 多 IMG 证据绑定
 *
 * 调用关系：Profession Repository 在技能目录替换事务中写入，生产上下文读取并冻结到 Job payload；
 * Drizzle migration 消费本表定义。输入仅是已由 Service 验证的技能、Inventory 和 Entry 标识。
 * 安全边界：复合外键保证每个 Entry 属于技能冻结的同一 Inventory；本表不保存官方字节、帧像素、
 * 本机路径或可执行参数，也不能把非空集合扩大为全技能覆盖或客户端兼容证明。
 */
import {
  foreignKey,
  int,
  mysqlTable,
  primaryKey,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { npkInventoryEntries } from "./schema.js";
import { professionSkills } from "./studio-schema.js";

/** 一个职业技能所引用的有序 Inventory Entry；ordinal 只定义冻结顺序，不表达动作阶段。 */
export const professionSkillSourceEntries = mysqlTable(
  "profession_skill_source_entries",
  {
    professionId: varchar("profession_id", { length: 64 }).notNull(),
    skillId: varchar("skill_id", { length: 64 }).notNull(),
    sourceInventoryId: varchar("source_inventory_id", {
      length: 64,
    }).notNull(),
    sourceInventoryEntryId: varchar("source_inventory_entry_id", {
      length: 64,
    }).notNull(),
    ordinal: int("ordinal", { unsigned: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.skillId, table.sourceInventoryEntryId],
      name: "profession_skill_source_entries_pk",
    }),
    uniqueIndex("profession_skill_source_entries_ordinal_uq").on(
      table.skillId,
      table.ordinal,
    ),
    foreignKey({
      columns: [table.professionId, table.skillId, table.sourceInventoryId],
      foreignColumns: [
        professionSkills.professionId,
        professionSkills.id,
        professionSkills.sourceInventoryId,
      ],
      name: "profession_skill_source_entries_skill_inventory_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.sourceInventoryId, table.sourceInventoryEntryId],
      foreignColumns: [npkInventoryEntries.inventoryId, npkInventoryEntries.id],
      name: "profession_skill_source_entries_inventory_entry_fk",
    }).onDelete("restrict"),
  ],
);
