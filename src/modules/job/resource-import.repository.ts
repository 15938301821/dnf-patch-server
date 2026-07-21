/**
 * @fileoverview 查询资源导入 Run 的 Job 状态；不处理租约、状态转换或资源正文。
 * @module job
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端资源导入业务直接需求）
 */
import { Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DatabaseService } from "../../common/db/database.service.js";
import { jobs, runs } from "../../common/db/schema.js";
import {
  persistedJobStatusSchema,
  type JobStateView,
} from "./job.contracts.js";

@Injectable()
export class ResourceImportRepository {
  constructor(private readonly connection: DatabaseService) {}

  async findLatestByProject(
    projectId: string,
  ): Promise<JobStateView | undefined> {
    const [row] = await this.connection.database
      .select(jobStateSelection)
      .from(jobs)
      .innerJoin(runs, eq(runs.id, jobs.runId))
      .where(
        and(
          eq(runs.projectId, projectId),
          eq(runs.action, "import-resources"),
          eq(jobs.kind, "inventory"),
        ),
      )
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(1);
    return row ? toJobStateView(row) : undefined;
  }

  async findByRun(runId: string): Promise<JobStateView | undefined> {
    const [row] = await this.connection.database
      .select(jobStateSelection)
      .from(jobs)
      .where(and(eq(jobs.runId, runId), eq(jobs.kind, "inventory")))
      .limit(1);
    return row ? toJobStateView(row) : undefined;
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
