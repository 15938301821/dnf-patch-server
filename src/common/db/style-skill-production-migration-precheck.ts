/**
 * @fileoverview 在 0019 为单技能生产记录增加 attempt、上传会话和错误证据前执行只读预检。
 * @module common/db/style-skill-production-migration-precheck
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：migration CLI 在 Drizzle 执行 SQL 前传入目标 MySQL 连接；本模块读取
 * information_schema 和历史终态计数，返回可迁移结论或稳定错误码。
 * 安全边界：不得猜测 Worker、lease、attempt 或 upload provenance；检测到旧终态或部分 DDL 时
 * 必须 fail-closed，不得回填、修改或输出业务行。
 */
import type { PoolConnection, RowDataPacket } from "mysql2/promise";

/** 0019 新增、可用于识别 schema 是否已完成演进的列数。 */
const expectedEvidenceColumnCount = 7;
/** 不含同名替换 CHECK 的 0019 新约束数，避免把旧 schema 误判为已完成。 */
const expectedMarkerConstraintCount = 5;

/** 固定 COUNT 查询的数据库行；mysql2 可能把数值返回为 number 或 string。 */
interface CountRow extends RowDataPacket {
  count: number | string;
}

/**
 * 阻断无法证明当前 attempt 和上传归属的历史单技能终态，并识别 MySQL 部分 DDL 状态。
 *
 * @param connection migration CLI 从目标 MySQL 池借用的连接，只执行本模块固定 SQL。
 * @returns 新库、未迁移且无不兼容终态，或已完整应用 0019 时完成。
 * @throws Error 旧终态无法可信回填时抛出
 * `STYLE_SKILL_PRODUCTION_EVIDENCE_MIGRATION_BLOCKED`；只存在部分 0019 列或约束时抛出
 * `STYLE_SKILL_PRODUCTION_EVIDENCE_MIGRATION_PARTIAL`。
 */
export async function assertStyleSkillProductionEvidenceMigrationReady(
  connection: PoolConnection,
): Promise<void> {
  // 新数据库没有旧表，由完整 migration 链创建，不存在历史证据迁移问题。
  const tableExists =
    (await scalarCount(
      connection,
      "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'style_skill_productions'",
    )) > 0;
  if (!tableExists) return;

  // 通过新增列和新增约束共同识别完整 0019，避免仅凭单个同名 CHECK 得出结论。
  const evidenceColumnCount = await scalarCount(
    connection,
    "SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'style_skill_productions' AND column_name IN ('worker_id','lease_id','attempt','aseprite_adapter_sha256','aseprite_upload_id','validation_upload_id','error_code')",
  );
  const markerConstraintCount = await scalarCount(
    connection,
    "SELECT COUNT(*) AS count FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'style_skill_productions' AND constraint_name IN ('style_skill_productions_error_evidence_ck','style_skill_productions_worker_id_workers_id_fk','style_skill_productions_attempt_lease_fk','style_skill_productions_aseprite_upload_fk','style_skill_productions_validation_upload_fk')",
  );
  if (
    evidenceColumnCount === expectedEvidenceColumnCount &&
    markerConstraintCount === expectedMarkerConstraintCount
  ) {
    return;
  }
  if (evidenceColumnCount !== 0 || markerConstraintCount !== 0) {
    throw new Error("STYLE_SKILL_PRODUCTION_EVIDENCE_MIGRATION_PARTIAL");
  }

  // 旧 passed 和绑定 Job 的失败终态缺少不可推断的新证据，禁止用默认值伪造来源链。
  const incompatibleTerminalCount = await scalarCount(
    connection,
    "SELECT COUNT(*) AS count FROM `style_skill_productions` WHERE `status` = 'passed' OR (`status` IN ('failed','blocked') AND `job_id` IS NOT NULL)",
  );
  if (incompatibleTerminalCount > 0) {
    throw new Error("STYLE_SKILL_PRODUCTION_EVIDENCE_MIGRATION_BLOCKED");
  }
}

/** 执行固定 COUNT SQL，并拒绝缺失、负数、非整数和超出安全整数的驱动结果。 */
async function scalarCount(
  connection: PoolConnection,
  statement: string,
): Promise<number> {
  const [rows] = await connection.query<CountRow[]>(statement);
  const value = rows[0]?.count;
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error("MIGRATION_PRECHECK_INVALID_RESULT");
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("MIGRATION_PRECHECK_INVALID_RESULT");
  }
  return count;
}
