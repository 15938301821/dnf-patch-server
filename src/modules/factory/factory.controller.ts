import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import {
  createFactorySchema,
  type CreateFactoryInput,
  type FactoryView,
} from "./factory.contracts.js";
import { FactoryService } from "./factory.service.js";

@Controller("factories")
export class FactoryController {
  constructor(private readonly factories: FactoryService) {}

  @Get()
  list(): Promise<FactoryView[]> {
    return this.factories.list();
  }

  @Get(":id")
  get(@Param("id") id: string): Promise<FactoryView> {
    return this.factories.get(id);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createFactorySchema)) input: CreateFactoryInput,
  ): Promise<FactoryView> {
    return this.factories.create(input);
  }
}
