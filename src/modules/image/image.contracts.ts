/**
 * @fileoverview 定义 Image Attempt 创建 DTO 与脱敏读取 ViewModel；不读写数据库、不生成图片，也不接受运行时图片字节。
 * @module modules/image/contracts
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：ImageController 用创建 schema 校验 HTTP body，ImageService 和 ImageRepository 消费已校验输入并产生读取视图。
 * 输入输出：DTO（Data Transfer Object，运行时校验后的传输结构）来自浏览器请求；ViewModel 是返回调用方的脱敏结构，不是数据库行。
 * 副作用：本文件仅声明校验与类型，不产生数据库、对象存储或模型 I/O。
 * 安全边界：未知字段和不合法状态组合必须在路由边界拒绝；directRuntimeUseAllowed 固定为 false，不证明图片兼容、已部署或可直接运行。
 */
import { z } from "zod";
import { sha256Schema } from "../../common/contracts/index.js";

/**
 * 校验创建 Image Attempt 的受限元数据。
 *
 * 由 ImageController 在调用 Service 前解析 HTTP body，ImageService 仅接收该 DTO；生成或适配完成状态必须有同 Run 的输出 Artifact。
 * 解析成功只证明字段格式与状态组合受限，不证明 Artifact 存在、归属正确、图片可用或模型调用成功；不访问数据库或外部 I/O。
 */
export const createImageAttemptSchema = z
  .object({
    modelCallId: z.uuid().optional(),
    promptSha256: sha256Schema,
    inputSnapshotSha256: sha256Schema,
    generationConfigSha256: sha256Schema,
    actualSeed: z.string().max(80).optional(),
    adapterIdentity: z.string().trim().min(1).max(200),
    outputArtifactId: z.uuid().optional(),
    status: z.enum(["planned", "generated", "failed", "adapted"]),
    directRuntimeUseAllowed: z.literal(false).default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.status === "generated" || value.status === "adapted") &&
      value.outputArtifactId === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["outputArtifactId"],
        message: "已生成或已适配的 Image Attempt 必须绑定输出 Artifact。",
      });
    }
  });

/** ImageController 传给 ImageService 的已校验 Image Attempt DTO，不是持久化数据库行。 */
export type CreateImageAttemptInput = z.infer<typeof createImageAttemptSchema>;

/**
 * 返回给调用方的 Image Attempt ViewModel。
 *
 * Repository 在成功写入后构造该脱敏视图；它含记录与 Run 归属及创建时间，但不含图片字节、模型密钥或数据库内部字段。
 */
export interface ImageAttemptView extends CreateImageAttemptInput {
  id: string;
  runId: string;
  createdAtUtc: string;
}
