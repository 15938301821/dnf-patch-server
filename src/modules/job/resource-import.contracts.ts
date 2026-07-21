/**
 * @fileoverview 定义浏览器资源导入状态与任务响应；不接受路径、命令或资源正文。
 * @module job
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端资源导入业务直接需求）
 */
import { z } from "zod";

export const createResourceImportJobSchema = z.union([
  z.undefined(),
  z.object({}).strict(),
]);

export type CreateResourceImportJobInput = z.infer<
  typeof createResourceImportJobSchema
>;

export type ResourceImportStatus =
  | "not-configured"
  | "idle"
  | "queued"
  | "running"
  | "failed";

export interface ResourceImportOverview {
  mode: "server-mirror";
  status: ResourceImportStatus;
  resourceVersion?: string;
  resourceRootConfigured: boolean;
  lastImportedAt?: string;
  lastJobId?: string;
  message: string;
}

export interface ResourceImportJob {
  id: string;
  mode: "server-mirror";
  status: "queued" | "running" | "failed";
  createdAt: string;
}
