/**
 * @fileoverview 定义浏览器创建共享特效任务的最小输入和只读状态；不接收路径、工具或资源映射。
 * @module job
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-001-SHARED-FX
 */
import { z } from "zod";
import { clientIdSchema } from "../../common/contracts/index.js";

/** 调用方只能选择已有 Project Snapshot 和客户端 Run 标识，冻结内容由服务端构建。 */
export const createSharedFxTaskSchema = z
  .object({
    projectId: z.uuid(),
    snapshotId: z.uuid(),
    clientRunId: clientIdSchema,
  })
  .strict();

export type CreateSharedFxTaskInput = z.infer<typeof createSharedFxTaskSchema>;

export interface SharedFxTaskView {
  id: string;
  status: "queued" | "blocked";
  createdAt: string;
}
