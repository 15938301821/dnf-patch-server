/**
 * @fileoverview 执行职业风格草稿的受保护物理删除事务；不处理 HTTP、审核状态推进或任务取消。
 * @module profession
 * @author AI生成
 * @created 2026-07-29
 * @relatedPlan N/A（用户直接需求：职业风格增加删除功能）
 *
 * 调用关系：ProfessionRepository 把 DatabaseService、职业/风格 ID 与稳定用户 ID 传入本函数；
 * ProfessionService 再把内部结果映射为 404/409。函数不跨模块调用 Job Repository。
 * 输入输出：输入来自已认证浏览器命令，输出是模块内部删除结果，不暴露数据库行。
 * 副作用：在一个 transaction（全部成功才提交的数据库事务）中锁定风格与生产引用，删除技能
 * 子行和风格主行，并更新职业时间；任一步失败全部回滚。
 * 安全边界：所有权、发布状态、两类生产引用和限制性外键均不可绕过；删除不能取消 Run、Job、
 * Attempt 或 Artifact，也不能破坏已存在的生产证据。
 */
import { and, eq } from "drizzle-orm";
import type { DatabaseService } from "../../common/db/database.service.js";
import { stylePackages } from "../../common/db/style-package-schema.js";
import {
  professionStyles,
  professionStyleSkills,
  professions,
  styleSkillProductions,
} from "../../common/db/studio-schema.js";

/** Repository 删除命令的内部结果；Service 负责把它映射为 HTTP 语义。 */
export type DeleteProfessionStyleResult = "deleted" | "not-found" | "protected";

/**
 * 原子删除可撤销的风格草稿及其技能子行。
 *
 * @param connection 职业 Repository 注入的数据库连接服务。
 * @param professionId 已通过 HTTP path 校验的职业 UUID。
 * @param styleId 已通过 HTTP path 校验的风格 UUID，必须与职业复合归属一致。
 * @param ownerUserId 从浏览器 Access Token 解析的稳定用户 ID，不能来自 body/query。
 * @returns deleted 表示主行和技能子行已删除；其他结果由 Service 映射为稳定异常。
 */
export function deleteProfessionStyle(
  connection: DatabaseService,
  professionId: string,
  styleId: string,
  ownerUserId: string,
): Promise<DeleteProfessionStyleResult> {
  return connection.database.transaction(async (transaction) => {
    // 第一步：锁定属于当前用户的风格主行，防止删除检查与保存/生产建立引用交错执行。
    const [style] = await transaction
      .select({
        id: professionStyles.id,
        publishStatus: professionStyles.publishStatus,
      })
      .from(professionStyles)
      .innerJoin(
        professions,
        and(
          eq(professionStyles.professionId, professions.id),
          eq(professions.ownerUserId, ownerUserId),
        ),
      )
      .where(
        and(
          eq(professionStyles.professionId, professionId),
          eq(professionStyles.id, styleId),
        ),
      )
      .limit(1)
      .for("update");
    if (!style) return "not-found";

    // 第二步：审核中的/已发布内容是历史模板，必须保留；私有和被驳回草稿才可撤销。
    if (
      style.publishStatus !== "private" &&
      style.publishStatus !== "rejected"
    ) {
      return "protected";
    }

    // 第三步：按技能生产 -> 风格包的固定顺序锁定引用；同一事务连接不并发发起 SQL。
    const skillProduction = await transaction
      .select({ id: styleSkillProductions.id })
      .from(styleSkillProductions)
      .where(eq(styleSkillProductions.styleId, styleId))
      .limit(1)
      .for("update");
    const stylePackage = await transaction
      .select({ id: stylePackages.id })
      .from(stylePackages)
      .where(eq(stylePackages.styleId, styleId))
      .limit(1)
      .for("update");
    if (skillProduction.length > 0 || stylePackage.length > 0) {
      return "protected";
    }

    // 第四步：先删技能子行，再删主行并更新时间；任一步失败事务回滚，职业摘要不会失真。
    await transaction
      .delete(professionStyleSkills)
      .where(
        and(
          eq(professionStyleSkills.professionId, professionId),
          eq(professionStyleSkills.styleId, styleId),
        ),
      );
    const deleted = await transaction
      .delete(professionStyles)
      .where(
        and(
          eq(professionStyles.professionId, professionId),
          eq(professionStyles.id, styleId),
        ),
      );
    if (deleted[0].affectedRows !== 1) {
      throw new Error("STYLE_DELETE_UPDATE_FAILED");
    }
    await transaction
      .update(professions)
      .set({ updatedAt: new Date() })
      .where(eq(professions.id, professionId));
    return "deleted";
  });
}
