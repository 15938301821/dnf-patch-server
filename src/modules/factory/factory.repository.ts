/**
 * @fileoverview 持久化 Factory 配置并将数据库 JSON 映射为经过 Zod 校验的 FactoryView；不处理 HTTP、
 * 配置哈希重算、Run 创建或 Worker 调度。
 * @module modules/factory/repository
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：FactoryService 调用本 Repository；Repository 使用 DatabaseService 的 Drizzle 连接读取或写入
 * factories 表，随后把记录映射为调用方可消费的 ViewModel。
 * 输入输出：输入是稳定 id 或 Service 已校验的 CreateFactoryInput；输出是 FactoryView 或 undefined，
 * 不返回原始 Drizzle 行和数据库 JSON。
 * 副作用：list/findById 只读数据库；create 插入一条启用记录。当前操作是单表写入，不创建 Run、Job、
 * 事件或 outbox。
 * 安全边界：读取 JSON 后再次用 factoryConfigSchema 解析，防止数据库 JSON 绕过 DTO 约束；Repository
 * 不接受任意 SQL、工具路径或 Worker 命令。
 */
import { Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { DatabaseService } from "../../common/db/database.service.js";
import { factories } from "../../common/db/schema.js";
import {
  factoryConfigSchema,
  type CreateFactoryInput,
  type FactoryView,
} from "./factory.contracts.js";

@Injectable()
/** Factory 数据访问边界；Controller 不应绕过 Service 直接注入本类。 */
export class FactoryRepository {
  /** @param connection 提供受应用生命周期管理的 Drizzle 数据库连接。 */
  constructor(private readonly connection: DatabaseService) {}

  /**
   * 查询所有当前启用的 Factory。
   * @returns 按创建时间倒序的 FactoryView；每条 config 均在映射时重新通过 Zod 校验。
   */
  async list(): Promise<FactoryView[]> {
    const rows = await this.connection.database
      .select()
      .from(factories)
      .where(eq(factories.enabled, true))
      .orderBy(desc(factories.createdAt));
    return rows.map(toFactoryView);
  }

  /**
   * 根据稳定 id 查询单个 Factory。
   * @param id 已由上游 schema 校验的 Factory 标识。
   * @returns 找到时返回 FactoryView；未找到返回 undefined，让 Service 映射为领域错误。
   */
  async findById(id: string): Promise<FactoryView | undefined> {
    const [row] = await this.connection.database
      .select()
      .from(factories)
      .where(eq(factories.id, id))
      .limit(1);
    return row ? toFactoryView(row) : undefined;
  }

  /**
   * 保存 Service 已确认唯一性和内容摘要的 Factory。
   * @param input 已通过严格 DTO 校验且由 Service 重算 configSha256 的创建输入。
   * @returns 新记录的 ViewModel；这一步不证明 Factory 已被 Run 或 Worker 使用。
   */
  async create(input: CreateFactoryInput): Promise<FactoryView> {
    const createdAt = new Date();
    await this.connection.database.insert(factories).values({
      id: input.id,
      version: input.version,
      displayName: input.displayName,
      config: input.config,
      configSha256: input.configSha256,
      enabled: true,
      createdAt,
    });
    return {
      ...input,
      enabled: true,
      createdAtUtc: createdAt.toISOString(),
    };
  }
}

/**
 * 将持久化行转换为对外 ViewModel，并在读取边界重新验证 JSON 配置。
 * @param row factories 表的单行结果，不能直接作为 API 响应泄露。
 * @returns 经过 factoryConfigSchema 解析的 FactoryView。
 * @throws 当历史数据库 JSON 不再满足版本化 Factory 契约时抛出，避免不安全地继续使用损坏配置。
 */
function toFactoryView(row: typeof factories.$inferSelect): FactoryView {
  return {
    id: row.id,
    version: row.version,
    displayName: row.displayName,
    config: factoryConfigSchema.parse(row.config),
    configSha256: row.configSha256,
    enabled: row.enabled,
    createdAtUtc: row.createdAt.toISOString(),
  };
}
