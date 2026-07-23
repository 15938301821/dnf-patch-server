/**
 * @fileoverview 提供对象存储端口的 Nest 注入令牌；不保存配置值或凭据。
 * @module common/storage
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 *
 * 调用关系：ObjectStorageModule 以这些 Symbol 注册 provider，ObjectStorageService 与领域模块按
 * 对应 token 注入。输入输出都是编译期类型和进程内 Symbol，无 I/O。安全边界：token 只标识
 * 依赖槽位，不包含 endpoint、bucket 或凭据，也不得被当作对象访问授权。
 */
import type {
  ObjectStorageClientPort,
  ObjectStorageOptions,
  ObjectStoragePort,
} from "./object-storage.client.js";

/** 注入 ObjectStorageOptions 的唯一进程内标识，不携带配置值。 */
export const OBJECT_STORAGE_OPTIONS = Symbol("OBJECT_STORAGE_OPTIONS");
/** 注入内部 ObjectStorageClientPort 适配器的标识，领域模块不应直接消费。 */
export const OBJECT_STORAGE_CLIENT = Symbol("OBJECT_STORAGE_CLIENT");
/** 注入领域稳定 ObjectStoragePort 的标识，避免 AWS SDK 类型扩散。 */
export const OBJECT_STORAGE_PORT = Symbol("OBJECT_STORAGE_PORT");

/** OBJECT_STORAGE_OPTIONS Symbol 的精确类型，供 Nest provider 元数据使用。 */
export type ObjectStorageOptionsToken = typeof OBJECT_STORAGE_OPTIONS;
/** OBJECT_STORAGE_CLIENT Symbol 的精确类型，供内部 provider 元数据使用。 */
export type ObjectStorageClientToken = typeof OBJECT_STORAGE_CLIENT;
/** OBJECT_STORAGE_PORT Symbol 的精确类型，供领域 provider 元数据使用。 */
export type ObjectStoragePortToken = typeof OBJECT_STORAGE_PORT;

/** options token 对应的值类型；不包含对象存储凭据。 */
export type ObjectStorageOptionsProviderValue = ObjectStorageOptions;
/** client token 对应的基础设施适配器类型。 */
export type ObjectStorageClientProviderValue = ObjectStorageClientPort;
/** port token 对应的领域稳定端口类型。 */
export type ObjectStoragePortProviderValue = ObjectStoragePort;
