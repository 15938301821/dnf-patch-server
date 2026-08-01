/**
 * @fileoverview 为单技能接收测试提供按查询顺序结算的最小 Drizzle transaction stub。
 *
 * 调用关系：主 fixture 生成业务证据行后调用本模块，行为测试再把 connection 传给真实 Repository。
 * 输入是有序查询结果和 passed DTO，输出包含数据库替身、行锁记录与更新观察值。副作用仅记录
 * Vitest mock 调用；不连接 MySQL，也不证明真实 CHECK、外键或并发锁行为。
 */
import { vi } from "vitest";
import type { DatabaseService } from "../../../../src/common/db/database.service.js";
import type { ReportPatchTaskSkillProductionInput } from "../../../../src/modules/job/patch-task.contracts.js";

type PassedReport = Extract<
  ReportPatchTaskSkillProductionInput,
  { status: "passed" }
>;

/** 测试可观察的数据库端口、passed 输入、锁调用和写入记录。 */
export interface SkillProductionReportHarness {
  connection: DatabaseService;
  input: PassedReport;
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  forUpdate: (lock: string) => void;
  updated: Record<string, unknown>[];
}

/**
 * 建立一个按 select 调用次序返回证据行的事务替身。
 * @param selectRows 主 fixture 已按真实接收查询顺序排列的结果集。
 * @param input 当前测试场景的严格 passed DTO。
 * @returns 可调用真实 Repository 的连接与全部可观察 mock。
 */
export function createSkillProductionTransactionHarness(
  selectRows: unknown[][],
  input: PassedReport,
): SkillProductionReportHarness {
  let selectIndex = 0;
  const forUpdateMock = vi.fn();
  const recordForUpdate = (lock: string): void => {
    forUpdateMock(lock);
  };
  const select = vi.fn(() => {
    const rows = selectRows[selectIndex] ?? [];
    selectIndex += 1;
    return { from: vi.fn(() => queryBuilder(rows, recordForUpdate)) };
  });
  const updated: Record<string, unknown>[] = [];
  const update = vi.fn(() => ({
    set: vi.fn((value: Record<string, unknown>) => ({
      where: vi.fn(() => {
        updated.push(value);
        return Promise.resolve([{ affectedRows: 1 }]);
      }),
    })),
  }));
  const transaction = vi.fn(
    (
      callback: (transaction: {
        select: typeof select;
        update: typeof update;
      }) => unknown,
    ) => Promise.resolve(callback({ select, update })),
  );
  return {
    connection: {
      database: { transaction },
    } as unknown as DatabaseService,
    input,
    select,
    update,
    forUpdate: forUpdateMock,
    updated,
  };
}

/** 构造支持 Drizzle 链式调用、Promise await 和 FOR UPDATE 观察的只读查询替身。 */
function queryBuilder(
  rows: unknown[],
  recordForUpdate: (lock: string) => void,
): Record<string, unknown> {
  const query = {
    innerJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(() => query),
    for: vi.fn((lock: string) => {
      recordForUpdate(lock);
      return Promise.resolve(rows);
    }),
    then: (resolve: (value: unknown[]) => unknown): Promise<unknown> =>
      Promise.resolve(rows).then(resolve),
  };
  return query;
}
