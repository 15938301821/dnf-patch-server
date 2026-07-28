/**
 * @fileoverview 按最新资源导入 Run 查询整批 Inventory Job 状态；不处理租约、状态转换或资源正文。
 * @module job
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端资源导入业务直接需求）
 */
import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq } from "drizzle-orm";
import { DatabaseService } from "../../common/db/database.service.js";
import { jobs, runs } from "../../common/db/schema.js";
import {
  persistedJobStatusSchema,
  type JobStateView,
} from "./job.contracts.js";

@Injectable()
export class ResourceImportRepository {
  constructor(private readonly connection: DatabaseService) {}

  /** 查询项目最近一次资源导入 Run 的全部 Inventory Job，保持创建顺序。 */
  async findLatestRunByProject(projectId: string): Promise<JobStateView[]> {
    const [run] = await this.connection.database
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(eq(runs.projectId, projectId), eq(runs.action, "import-resources")),
      )
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(1);
    return run ? this.findByRun(run.id) : [];
  }

  /** 查询指定 Run 的全部 Inventory Job；空数组表示 Run 不存在或没有该 kind。 */
  async findByRun(runId: string): Promise<JobStateView[]> {
    const rows = await this.connection.database
      .select(jobStateSelection)
      .from(jobs)
      .where(and(eq(jobs.runId, runId), eq(jobs.kind, "inventory")))
      .orderBy(asc(jobs.createdAt), asc(jobs.id));
    return rows.map(toJobStateView);
  }
}

const jobStateSelection = {
  id: jobs.id,
  runId: jobs.runId,
  status: jobs.status,
  createdAt: jobs.createdAt,
  updatedAt: jobs.updatedAt,
};

function toJobStateView(row: {
  id: string;
  runId: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): JobStateView {
  return {
    id: row.id,
    runId: row.runId,
    status: persistedJobStatusSchema.parse(row.status),
    createdAtUtc: row.createdAt.toISOString(),
    updatedAtUtc: row.updatedAt.toISOString(),
  };
}
