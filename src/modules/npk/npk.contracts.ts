/**
 * @fileoverview 定义 NPK Inventory 冻结元数据的普通/Worker 输入、路径规范化和公开证据 ViewModel；不读取、
 * 解析或修改 NPK/IMG 文件，也不执行本机工具。
 * @module modules/npk/contracts
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：NpkController 与 NpkWorkerController 使用这些 Zod schema 解析不同信任边界的 DTO；
 * NpkService 使用推导类型验证 Run/Artifact 归属并委托 Repository 冻结记录；职业和资源导入链路只消费
 * InventoryView/InventoryEntryEvidence 的有限证据。
 * 输入输出：输入是来源标签、来源摘要、有限条目元数据和 Worker lease 绑定；输出是不含 NPK 字节、对象 URL、
 * 游戏路径、工具配置或 Worker token 的 ViewModel。
 * 副作用：本文件只做内存解析与字符串规范化，不访问数据库、对象存储或官方游戏资源。
 * 安全边界：schema 成功只证明元数据格式和预算，不证明条目由 NPK 正文重新解析、资源映射正确或客户端可用；
 * Worker DTO 不允许自行声明 runId，必须依赖服务器从精确 lease 反查 Job 所属 Run。
 */
import { z } from "zod";
import {
  repositoryRelativePathSchema,
  sha256Schema,
} from "../../common/contracts/index.js";

/**
 * 将 NPK 内部相对路径转换为唯一比较键。
 * @param value 已通过相对路径形状校验的原始内部路径；可含反斜杠或 Unicode 等价表示。
 * @returns 使用 `/`、NFC 与小写的稳定路径，用于 DTO 去重、Service 冲突检查和数据库唯一性前的写入。
 * @remarks 此函数不解析磁盘路径或访问游戏目录；所有重复判断必须使用同一规则，避免大小写或 Unicode 绕过。
 */
export function normalizeNpkInternalPath(value: string): string {
  return value.replaceAll("\\", "/").normalize("NFC").toLowerCase();
}

/**
 * NPK 内部路径的严格 schema。
 * 在通用仓库相对路径规则外拒绝控制字符，随后统一规范化；它不是本机文件系统路径，不能据此访问磁盘。
 */
const npkInternalPathSchema = repositoryRelativePathSchema
  .refine(
    (value) =>
      !Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0);
        return (
          codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
        );
      }),
    { message: "NPK 内部路径不能包含控制字符。" },
  )
  .transform(normalizeNpkInternalPath);

/**
 * 单个已扫描 NPK/IMG 条目的有界元数据。
 * metadataSha256 绑定条目元数据证据，不携带帧像素、IMG 字节、游戏目录或资源映射结论。
 */
export const inventoryEntrySchema = z
  .object({
    internalPath: npkInternalPathSchema,
    imgVersion: z.number().int().min(1).max(6),
    frameCount: z.number().int().min(0).max(1_000_000),
    metadataSha256: sha256Schema,
  })
  .strict();

/**
 * 普通业务入口创建 Inventory 的严格 DTO。
 * 可选 inventoryArtifactId 在 Service 中验证归属；该 DTO 格式正确不证明 Artifact 已 finalized，
 * 也不替代 Worker 回填路径要求的精确 lease/attempt 证据。
 */
export const createInventorySchema = z
  .object({
    runId: z.uuid(),
    sourceLabel: z.string().trim().min(1).max(200),
    sourceLength: z.number().int().min(1).max(4_294_967_295),
    sourceSha256: sha256Schema,
    inventoryArtifactId: z.uuid().optional(),
    entries: z.array(inventoryEntrySchema).min(1).max(100_000),
  })
  .strict();

/**
 * Worker 回填 Inventory 的严格 DTO。
 * 移除调用方可伪造的 runId，并强制 workerId、leaseId、attempt 与 finalized Artifact；Repository 必须用
 * 数据库时间和锁定 Job 再次验证它们，不能只相信 schema 成功。
 */
export const createWorkerInventorySchema = createInventorySchema
  .omit({
    runId: true,
    inventoryArtifactId: true,
  })
  .extend({
    workerId: z.uuid(),
    leaseId: z.uuid(),
    attempt: z.number().int().min(1).max(10),
    inventoryArtifactId: z.uuid(),
    sourceFrameManifestArtifactId: z.uuid(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.inventoryArtifactId === input.sourceFrameManifestArtifactId) {
      context.addIssue({
        code: "custom",
        path: ["sourceFrameManifestArtifactId"],
        message: "Inventory 与源帧清单必须使用不同 Artifact。",
      });
    }
  });

/** 普通 NPK Inventory 创建路径收到的已解析输入，不是数据库行或 NPK 文件内容。 */
export type CreateInventoryInput = z.infer<typeof createInventorySchema>;

/** Worker 回填路径收到的已解析输入，仍须由 Repository 验证 Job/Run/lease/attempt/Artifact 一致性。 */
export type CreateWorkerInventoryInput = z.infer<
  typeof createWorkerInventorySchema
>;

/** 已通过 inventoryEntrySchema 校验的单个条目元数据，不包含资源正文或本机定位信息。 */
export type InventoryEntryInput = z.infer<typeof inventoryEntrySchema>;

/**
 * 对 API 与跨模块 Service 公开的冻结 Inventory 摘要。
 * `frozen` 只表示当前写入路径的状态不变量，不证明实际 NPK 已再次读取、全技能覆盖或客户端兼容。
 */
export interface InventoryView {
  id: string;
  projectId: string;
  runId: string;
  sourceLabel: string;
  sourceLength: number;
  sourceSha256: string;
  status: "frozen";
  inventoryArtifactId?: string;
  sourceFrameManifestArtifactId?: string;
  entryCount: number;
  createdAtUtc: string;
}

/**
 * 下游职业/资源链路用于校验归属的最小条目证据。
 * 它不返回 internalPath、IMG/NPK 内容或对象存储定位；调用方仍须比较 projectId、runId 与 metadataSha256。
 */
export interface InventoryEntryEvidence {
  id: string;
  inventoryId: string;
  projectId: string;
  runId: string;
  metadataSha256: string;
  sourceFrameManifestArtifactId?: string;
}

/**
 * Worker 回填事务的有限结果。
 * `accepted` 包括同一 finalized Artifact 的幂等重报；其他状态必须由 Service 映射为阻断性业务错误，
 * 不能被 Worker 当作可忽略警告后继续报告成功。
 */
export type WorkerInventoryMutationResult =
  | { status: "accepted"; inventory: InventoryView }
  | {
      status:
        | "lease-mismatch"
        | "job-kind-mismatch"
        | "artifact-not-finalized"
        | "artifact-evidence-mismatch";
    };
