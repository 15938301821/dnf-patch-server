import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { sha256Json } from "../../common/utils/canonical.js";
import type { CreateFactoryInput, FactoryView } from "./factory.contracts.js";
import { FactoryRepository } from "./factory.repository.js";

@Injectable()
export class FactoryService {
  constructor(private readonly factories: FactoryRepository) {}

  list(): Promise<FactoryView[]> {
    return this.factories.list();
  }

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
