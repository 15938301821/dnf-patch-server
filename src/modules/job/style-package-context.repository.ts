/**
 * @fileoverview 在当前 npk-package Job 的行锁事务中聚合全部 passed 技能及双 ZIP Artifact，
 * 生成 attempt-bound Package V3 context；不读取对象正文、不签发下载、不执行封包器或更新状态。
 * @module modules/job/style-package-context-repository
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - Package V3 首个纵向协议切片
 *
 * 调用关系：StylePackageContextService 调用本 Repository；本类先锁定 Job 并按数据库时间验证
 * lease，再解析持久化 V3 payload，最后按冻结技能顺序复核 style_skill_productions 与 Artifact。
 * 输入输出：输入为当前 claim 的三字段 fencing DTO；输出为规范 context 信封或有限拒绝状态。
 * 副作用：只读事务会取得 Job row lock。安全边界：Artifact ID、状态或同 Run 外键本身都不够，
 * 还必须核对固定逻辑名、媒体类型、长度、SHA-256、严格 provenance、producing attempt 和角色绑定。
 */
import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DatabaseService } from "../../common/db/database.service.js";
import { jobs } from "../../common/db/schema.js";
import { databaseNow } from "./job-run-event.repository-support.js";
import { type RequestStylePackageContextV3 } from "./style-package-production.contracts.js";
import {
  resolveStylePackageContextInTransaction,
  type ResolveStylePackageContextResult,
} from "./style-package-context.repository-support.js";

export type { ResolveStylePackageContextResult } from "./style-package-context.repository-support.js";

/** Package V3 context 的只读数据访问边界，拥有 Job 锁和多表证据聚合。 */
@Injectable()
export class StylePackageContextRepository {
  /** @param connection 应用共享 Drizzle 连接；Controller 不得绕过 Service 直接使用。 */
  constructor(private readonly connection: DatabaseService) {}

  /**
   * 为当前 package attempt 生成规范化冻结 context。
   *
   * @param jobId 当前已领取的 npk-package Job UUID。
   * @param input claim 返回的 workerId、leaseId 与 attempt，三者必须同时匹配数据库权威 lease。
   * @returns accepted 时返回完整信封；其他状态不返回部分技能或 Artifact 信息。
   */
  async resolve(
    jobId: string,
    input: RequestStylePackageContextV3,
  ): Promise<ResolveStylePackageContextResult> {
    return this.connection.database.transaction(async (transaction) => {
      // 第一步：Job 锁阻止 complete/reaper 在证据聚合中途改变当前 package attempt。
      const [job] = await transaction
        .select()
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1)
        .for("update");
      if (!job) return { status: "lease-mismatch" };
      const now = await databaseNow(transaction);
      return resolveStylePackageContextInTransaction(
        transaction,
        job,
        input,
        now,
      );
    });
  }
}
