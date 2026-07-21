/**
 * @fileoverview 验证浏览器 PatchTask HTTP 边界的幂等请求头，不覆盖 Service 业务编排。
 * @module job
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端业务与后端工作流直接需求）
 */
import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../auth/auth.service.js";
import { PatchTaskController } from "./job.controller.js";
import type {
  CreatePatchTaskInput,
  PatchTaskView,
} from "./patch-task.contracts.js";
import { PatchTaskService } from "./patch-task.service.js";

const input: CreatePatchTaskInput = {
  professionId: "11111111-1111-4111-8111-111111111111",
  styleId: "22222222-2222-4222-8222-222222222222",
};
const ownerUserId = "44444444-4444-4444-8444-444444444444";
const task: PatchTaskView = {
  id: "33333333-3333-4333-8333-333333333333",
  professionName: "剑魂",
  styleName: "暗蓝幻影",
  status: "queued",
  progress: 0,
  createdAt: "2026-07-21T00:00:00.000Z",
  artifactAvailable: false,
};

describe("PatchTaskController", () => {
  const create =
    vi.fn<
      (
        input: CreatePatchTaskInput,
        key: string,
        ownerUserId: string,
      ) => Promise<PatchTaskView>
    >();
  const requireBrowserUser = vi.fn();
  let controller: PatchTaskController;

  beforeEach(async () => {
    vi.resetAllMocks();
    create.mockResolvedValue(task);
    requireBrowserUser.mockResolvedValue({ id: ownerUserId });
    const module = await Test.createTestingModule({
      providers: [
        { provide: PatchTaskService, useValue: { create } },
        { provide: AuthService, useValue: { requireBrowserUser } },
        {
          provide: PatchTaskController,
          inject: [PatchTaskService, AuthService],
          useFactory: (
            patchTasks: PatchTaskService,
            auth: AuthService,
          ): PatchTaskController => new PatchTaskController(patchTasks, auth),
        },
      ],
    }).compile();
    controller = module.get(PatchTaskController);
  });

  it.each([undefined, "", "contains spaces", "patch/"])(
    "rejects an invalid Idempotency-Key header: %s",
    (idempotencyKey) => {
      expect(() =>
        controller.create(idempotencyKey, "Bearer access", input),
      ).toThrow(BadRequestException);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("passes a valid Idempotency-Key to the task service unchanged", async () => {
    await expect(
      controller.create("patch.request-1", "Bearer access", input),
    ).resolves.toEqual({ data: task });
    expect(requireBrowserUser).toHaveBeenCalledWith("Bearer access");
    expect(create).toHaveBeenCalledWith(input, "patch.request-1", ownerUserId);
  });
});
