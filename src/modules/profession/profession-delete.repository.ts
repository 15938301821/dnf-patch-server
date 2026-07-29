/**
 * @fileoverview 执行空职业的受保护删除事务；不级联删除技能、风格、生产记录或资源证据。
 * @module profession
 * @author AI生成
 * @created 2026-07-29
 * @relatedPlan N/A（用户直接需求：职业列表增加删除功能）
 *
 * 调用关系：ProfessionRepository 传入 DatabaseService 与浏览器命令中的职业/用户 ID，
 * ProfessionService 将内部结果映射为稳定 404/409。函数不调用其他领域 Repository。
 * 输入输出：输入是已校验职业 UUID 与 Access Token 解析的稳定用户 ID；输出仅为模块内部结果。
 * 副作用：在一个 transaction 中锁定职业及其直接内容引用，仅在内容为空时删除职业主行。
 * 安全边界：所有权、发布状态、风格和技能目录检查均不可绕过；限制性外键继续作为最终保护，
 * 禁止通过职业删除破坏 Run、Job、Artifact、Inventory 或审核历史。
 */
import { and, eq } from "drizzle-orm";
import type { DatabaseService } from "../../common/db/database.service.js";
import {
  professionSkills,
  professionStyles,
  professions,
} from "../../common/db/studio-schema.js";

/** Repository 职业删除命令的内部结果；Service 负责映射公开 HTTP 语义。 */
export type DeleteProfessionResult = "deleted" | "not-found" | "protected";

/**
 * 原子删除当前用户拥有且没有技能/风格内容的可撤销职业。
 *
 * @param connection ProfessionRepository 注入的数据库连接服务。
 * @param professionId Controller path 中已通过 UUID schema 校验的职业 ID。
 * @param ownerUserId 浏览器 Access Token 解析的稳定用户 ID，不能来自请求体。
 * @returns deleted 表示职业主行已删除；not-found 合并不存在与跨用户；protected 表示内容或状态受保护。
 */
export function deleteProfession(
  connection: DatabaseService,
  professionId: string,
  ownerUserId: string,
): Promise<DeleteProfessionResult> {
  return connection.database.transaction(async (transaction) => {
    // 第一步：按所有权过滤并锁定职业主行，防止并发创建技能/风格与删除检查交错。
    const [profession] = await transaction
      .select({
        id: professions.id,
        publishStatus: professions.publishStatus,
      })
      .from(professions)
      .where(
        and(
          eq(professions.id, professionId),
          eq(professions.ownerUserId, ownerUserId),
        ),
      )
      .limit(1)
      .for("update");
    if (!profession) return "not-found";

    // 第二步：审核中和已发布职业属于目录历史，不能通过个人列表执行物理删除。
    if (
      profession.publishStatus !== "private" &&
      profession.publishStatus !== "rejected"
    ) {
      return "protected";
    }

    // 第三步：按技能 -> 风格固定顺序锁定直接内容；任一存在都要求用户先清理内容。
    const skills = await transaction
      .select({ id: professionSkills.id })
      .from(professionSkills)
      .where(eq(professionSkills.professionId, professionId))
      .limit(1)
      .for("update");
    const styles = await transaction
      .select({ id: professionStyles.id })
      .from(professionStyles)
      .where(eq(professionStyles.professionId, professionId))
      .limit(1)
      .for("update");
    if (skills.length > 0 || styles.length > 0) return "protected";

    // 第四步：只删除空职业主行；限制性外键冲突会回滚，禁止返回虚假成功。
    const deleted = await transaction
      .delete(professions)
      .where(
        and(
          eq(professions.id, professionId),
          eq(professions.ownerUserId, ownerUserId),
        ),
      );
    if (deleted[0].affectedRows !== 1) {
      throw new Error("PROFESSION_DELETE_UPDATE_FAILED");
    }
    return "deleted";
  });
}
