/**
 * @fileoverview 验证共享特效模板浏览器接口绑定稳定用户身份和幂等键；不覆盖业务预检。
 * @module job
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-001-SHARED-FX
 */
import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthService } from "../auth/auth.service.js";
import type {
  CreateSharedFxTaskInput,
  SharedFxTaskView,
} from "./shared-fx-task.contracts.js";
import { SharedFxTaskController } from "./shared-fx-task.controller.js";
import type { SharedFxTaskService } from "./shared-fx-task.service.js";

const input: CreateSharedFxTaskInput = {
  projectId: "11111111-1111-4111-8111-111111111111",
  snapshotId: "22222222-2222-4222-8222-222222222222",
  clientRunId: "shared-fx.request-1",
};
const ownerUserId = "33333333-3333-4333-8333-333333333333";
const task: SharedFxTaskView = {
  id: "44444444-4444-4444-8444-444444444444",
  status: "queued",
  createdAt: "2026-07-22T00:00:00.000Z",
};

describe("SharedFxTaskController", () => {
  const create =
    vi.fn<
      (
        input: CreateSharedFxTaskInput,
        idempotencyKey: string,
        ownerUserId: string,
      ) => Promise<SharedFxTaskView>
    >();
  const requireBrowserUser = vi.fn();
  let controller: SharedFxTaskController;

  beforeEach(() => {
    vi.resetAllMocks();
    create.mockResolvedValue(task);
    requireBrowserUser.mockResolvedValue({ id: ownerUserId });
    controller = new SharedFxTaskController(
      { create } as unknown as SharedFxTaskService,
      { requireBrowserUser } as unknown as AuthService,
    );
  });

  it.each([undefined, "", "contains spaces", "shared-fx/"])(
    "rejects an invalid Idempotency-Key header: %s",
    async (idempotencyKey) => {
      await expect(
        controller.create(idempotencyKey, "Bearer access", input),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(create).not.toHaveBeenCalled();
      expect(requireBrowserUser).not.toHaveBeenCalled();
    },
  );

  it("passes the parsed idempotency key and stable browser owner unchanged", async () => {
    await expect(
      controller.create("shared-fx.request-1", "Bearer access", input),
    ).resolves.toEqual({ data: task });

    expect(requireBrowserUser).toHaveBeenCalledWith("Bearer access");
    expect(create).toHaveBeenCalledWith(
      input,
      "shared-fx.request-1",
      ownerUserId,
    );
  });
});
