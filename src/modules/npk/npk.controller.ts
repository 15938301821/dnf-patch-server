import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import {
  createInventorySchema,
  type CreateInventoryInput,
  type InventoryView,
} from "./npk.contracts.js";
import { NpkService } from "./npk.service.js";

@Controller("projects/:projectId/npk-inventories")
export class NpkController {
  constructor(private readonly inventories: NpkService) {}

  @Get()
  list(@Param("projectId") projectId: string): Promise<InventoryView[]> {
    return this.inventories.list(projectId);
  }

  @Post()
  create(
    @Param("projectId") projectId: string,
    @Body(new ZodValidationPipe(createInventorySchema))
    input: CreateInventoryInput,
  ): Promise<InventoryView> {
    return this.inventories.create(projectId, input);
  }
}
