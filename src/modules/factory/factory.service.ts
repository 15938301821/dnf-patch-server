/**
 * @fileoverview 编排 Factory 的读取、唯一性检查和冻结配置内容哈希校验；不处理 HTTP 参数、Drizzle 查询细节、
 * Run 创建或 Worker 本机执行。
 * @module modules/factory/service
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：FactoryController 和需要读取 Factory 的领域 Service 调用本类；本类委托
 * FactoryRepository 持久化，使用 canonical.sha256Json 计算客户端配置的确定性摘要。
 * 输入输出：输入是已由 Controller schema 校验的 id 或 CreateFactoryInput；输出是 FactoryView 或稳定
 * NotFound/Conflict 错误，不返回数据库行或可执行 Worker 配置。
 * 副作用：list/get 只读数据库；create 成功时插入一条 Factory。该模块不创建 Run、Job、事件或 outbox。
 * 安全边界：客户端提交的 configSha256 不能被直接信任；同 id 重复创建或规范化内容摘要不匹配必须失败，
 * 避免之后的 Run 使用未经证明的冻结策略。
 */
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { sha256Json } from "../../common/utils/canonical.js";
import type { CreateFactoryInput, FactoryView } from "./factory.contracts.js";
import { FactoryRepository } from "./factory.repository.js";

@Injectable()
/** Factory 业务命令层，向 Controller 隐藏 Repository 与确定性哈希实现。 */
export class FactoryService {
  /** @param factories Factory 的单表持久化边界。 */
  constructor(private readonly factories: FactoryRepository) {}

  /**
   * 列出当前可见的启用 Factory。
   * @returns Repository 映射后的 FactoryView 集合；可见不等于可立即创建生产 Run。
   */
  list(): Promise<FactoryView[]> {
    return this.factories.list();
  }

  /**
   * 读取一个 Factory，不存在时转换为稳定业务错误。
   * @param id 上游已校验的 Factory 标识。
   * @returns 存在的 FactoryView。
   * @throws FACTORY_NOT_FOUND 当持久化层没有找到该 id 时抛出。
   */
  async get(id: string): Promise<FactoryView> {
    const factory = await this.factories.findById(id);
    if (!factory) {
      throw new NotFoundException({
        code: "FACTORY_NOT_FOUND",
        message: "工厂模板不存在。",
      });
    }
    return factory;
  }

  /**
   * 校验唯一性和规范化内容摘要后创建 Factory。
   *
   * 步骤 1：先检查稳定 id，避免后续哈希计算后才发现重复；步骤 2：对已解析 JSON 重算 SHA-256，
   * 防止客户端用正确格式但错误摘要替换冻结策略；步骤 3：仅在两项不变量成立后委托 Repository 插入。
   * 任一步失败都不能写入 Factory，也不会创建 Run 或 Job。
   *
   * @param input Controller 已校验的创建 DTO，客户端摘要会在此处被独立复核。
   * @returns 持久化后的 FactoryView。
   * @throws FACTORY_ALREADY_EXISTS 或 FACTORY_CONFIG_HASH_MISMATCH 当唯一性或摘要证据不成立时抛出。
   */
  async create(input: CreateFactoryInput): Promise<FactoryView> {
    if (await this.factories.findById(input.id)) {
      throw new ConflictException({
        code: "FACTORY_ALREADY_EXISTS",
        message: "工厂模板 ID 已存在。",
      });
    }
    const configSha256 = sha256Json(input.config);
    if (configSha256 !== input.configSha256.toUpperCase()) {
      throw new ConflictException({
        code: "FACTORY_CONFIG_HASH_MISMATCH",
        message: "工厂配置哈希与提交内容不一致。",
      });
    }
    return this.factories.create({ ...input, configSha256 });
  }
}
