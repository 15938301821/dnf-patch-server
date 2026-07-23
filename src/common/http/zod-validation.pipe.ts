/**
 * @fileoverview 提供可复用的 Nest Zod 输入 Pipe，在 Controller 调用前把 unknown 转为已校验 DTO；
 * 不读取数据库、不执行认证，也不把 TypeScript 类型当作运行时信任依据。
 * @module common/http
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Controller 参数装饰器实例化 ZodValidationPipe 并传入具体 schema；Nest 把 body、
 * path、query 或 payload 交给 transform，成功后下游 Controller/Service 才收到 DTO（Data Transfer
 * Object，经运行时校验的传输结构，不等于数据库行或公开 ViewModel）。无外部副作用。
 * 安全边界：schema 必须自行设置 strict、长度和结构预算；解析失败统一为 400 且不得进入业务层。
 */
import {
  BadRequestException,
  Injectable,
  type PipeTransform,
} from "@nestjs/common";
import type { z } from "zod";

/** 将任意 Nest 参数按构造时绑定的 Zod schema 转为类型 T。 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  /**
   * @param schema 当前 Controller 参数专用的运行时 schema；由路由代码固定，不能来自请求。
   */
  constructor(private readonly schema: z.ZodType<T>) {}

  /**
   * 校验当前外部输入，并仅向 Controller 返回 schema 解析后的值。
   * @param value 来自 body/path/query 等边界的 unknown 值。
   * @returns schema 完整校验和转换后的 DTO。
   * @throws BadRequestException 当任一字段不符合契约时抛出 `VALIDATION_FAILED`，业务 Service 不会执行。
   */
  transform(value: unknown): T {
    // Zod 是进入业务层前的输入边界；safeParse 避免把原始异常或完整载荷带入公开响应。
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        code: "VALIDATION_FAILED",
        message: "请求数据不符合 API 契约。",
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}
