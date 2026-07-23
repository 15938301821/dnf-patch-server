/**
 * @fileoverview 定义跨模块外部输入使用的基础 Zod schema 与确定性资源预算；不包含领域 DTO、
 * 数据库访问或自动路径规范化。
 * @module common/contracts
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：各模块 contracts 在 HTTP、WebSocket、数据库 JSON 或 Worker payload 边界组合这些
 * schema。输入从 unknown 开始，输出是校验后的原值；无 I/O 副作用。安全边界：未知或超预算
 * JSON、绝对/父级路径及控制字符必须 fail-closed，不能依赖 TypeScript 静态类型代替解析。
 */
import { z } from "zod";

/** 校验由 API、数据库或内部契约生产的 UUID 标识，不推断实体归属。 */
export const idSchema = z.uuid();
/** 校验客户端生成的有界稳定 ID，供幂等或外部引用使用，禁止空段和任意符号。 */
export const clientIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u);
/** 校验 32 字节摘要的十六进制表示；只验证格式，不证明内容已经服务端复核。 */
export const sha256Schema = z.string().regex(/^[A-Fa-f0-9]{64}$/u);
/**
 * 限制开放 JSON 记录的键长、UTF-8 编码体积、嵌套深度与节点数。
 * 生产方包括 HTTP DTO 与数据库 JSON，消费方只能在本 schema 成功后遍历该值。
 */
export const boundedJsonRecordSchema = z
  .record(z.string().min(1).max(128), z.json())
  .superRefine((value, context) => {
    // 先限制序列化体积，再限制结构复杂度，防止小字符串承载极深或海量节点。
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, "utf8") > 65_536) {
      context.addIssue({
        code: "custom",
        message: "JSON 对象不能超过 64 KiB。",
      });
    }
    if (exceedsJsonBudget(value, 16, 10_000)) {
      context.addIssue({
        code: "custom",
        message: "JSON 对象层级或节点数量超过限制。",
      });
    }
  });
/** 校验可展示名称并拒绝路径保留字符和控制字符，避免日志、UI 与文件语义混淆。 */
export const safeDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((value) => !hasUnsafeDisplayNameCharacter(value), {
    message: "名称包含不安全字符。",
  });
/**
 * 校验仓库内相对引用；接受斜杠风格差异但拒绝根路径、盘符和 `..`，不访问文件系统。
 */
export const repositoryRelativePathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) => {
      const normalizedPath = value.replaceAll("\\", "/");
      return (
        !normalizedPath.startsWith("/") &&
        !/^[A-Za-z]:/u.test(normalizedPath) &&
        !normalizedPath.split("/").includes("..")
      );
    },
    { message: "必须提供安全的仓库相对路径。" },
  );

/**
 * 判断显示名是否包含跨平台路径保留字符或 C0 控制字符。
 * @param value 已完成 trim/长度校验、尚未被信任的外部显示名。
 * @returns 存在任一不安全字符时为 true；不修改原字符串。
 */
function hasUnsafeDisplayNameCharacter(value: string): boolean {
  if (/[<>:"/\\|?*]/u.test(value)) {
    return true;
  }
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint <= 0x1f;
  });
}

/**
 * 以显式栈遍历 JSON，阻止深递归和超量节点消耗 CPU/内存。
 * @param root 已通过 Zod JSON 值约束的根记录。
 * @param maxDepth 允许的最大层数，根记录计为第 1 层。
 * @param maxNodes 允许访问的最大值节点数，容器与标量都计数。
 * @returns 任一预算被突破时为 true；不会改变输入。
 */
function exceedsJsonBudget(
  root: Record<string, unknown>,
  maxDepth: number,
  maxNodes: number,
): boolean {
  const pending: Array<{ depth: number; value: unknown }> = [
    { depth: 1, value: root },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > maxNodes || current.depth > maxDepth) return true;
    if (current.value === null || typeof current.value !== "object") continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return false;
}
