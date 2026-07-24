/**
 * @fileoverview 创建服务进程共享的 MySQL 连接池与 Drizzle 数据库实例，并在 Nest 关闭时释放；
 * 不执行 migration、不拥有领域查询，也不把数据库行直接映射为 API ViewModel。
 * @module common/db
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：DatabaseModule 构造本 Service；各领域 Service/Repository 使用 database 或 pool 执行
 * 查询与 transaction。输入是已校验 DATABASE_URL/POOL_SIZE，输出是共享连接能力。副作用是创建
 * 连接池、按需建立 MySQL 连接、健康探测和关闭连接池。
 * 安全边界：连接 URL 只从 ConfigService 进入驱动，禁止日志/响应回显；transaction 是一组要么
 * 全部提交、要么全部回滚的操作，具体原子性与 row lock 必须由拥有业务状态的 Repository 建立。
 */
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import type { Environment } from "../../config/environment.js";
import * as artifactSchema from "./artifact-schema.js";
import * as browserSessionSchema from "./browser-session-schema.js";
import * as controlSchema from "./schema.js";
import * as professionModelExecutionSchema from "./profession-model-execution-schema.js";
import * as professionSourceSchema from "./profession-source-schema.js";
import * as stylePackageSchema from "./style-package-schema.js";
import * as studioSchema from "./studio-schema.js";

/** Drizzle 的统一关系 schema，只合并表定义，不在此处创建或迁移数据库结构。 */
const schema = {
  ...controlSchema,
  ...artifactSchema,
  ...browserSessionSchema,
  ...studioSchema,
  ...professionModelExecutionSchema,
  ...professionSourceSchema,
  ...stylePackageSchema,
};

/** 服务进程共享的数据库基础设施 provider；不封装任何领域 SQL。 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  /** mysql2 连接池，供需要底层 transaction/连接语义的 Repository 使用，不得暴露给 Controller。 */
  readonly pool: Pool;
  /** 绑定完整 schema 的 Drizzle 查询入口；返回数据库行而非对外 ViewModel。 */
  readonly database: MySql2Database<typeof schema>;

  /**
   * @param config AppModule 已通过 environmentSchema 校验的配置服务；连接 URL 不会被保存到公开字段。
   */
  constructor(config: ConfigService<Environment, true>) {
    this.pool = createPool({
      uri: config.getOrThrow("DATABASE_URL", { infer: true }),
      connectionLimit: config.getOrThrow("DATABASE_POOL_SIZE", { infer: true }),
      timezone: "Z",
      enableKeepAlive: true,
    });
    this.database = drizzle(this.pool, { schema, mode: "default" });
  }

  /**
   * 借用一个连接执行 MySQL 原生 ping，并无论成功失败都归还连接。
   * @returns ping 成功后完成；不返回驱动对象或连接信息。
   * @throws mysql2 连接/探测错误，由健康检查边界映射为脱敏不可用状态。
   */
  async ping(): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.ping();
    } finally {
      connection.release();
    }
  }

  /**
   * Nest 关闭钩子：停止连接池接受新工作并等待驱动释放资源。
   * @returns 连接池完成关闭后 resolve；不执行 migration 或业务补偿。
   */
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
