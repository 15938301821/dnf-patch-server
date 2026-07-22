/**
 * @fileoverview 提供对象存储端口的 Nest 注入令牌；不保存配置值或凭据。
 * @module common/storage
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 */
import type {
  ObjectStorageClientPort,
  ObjectStorageOptions,
  ObjectStoragePort,
} from "./object-storage.client.js";

export const OBJECT_STORAGE_OPTIONS = Symbol("OBJECT_STORAGE_OPTIONS");
export const OBJECT_STORAGE_CLIENT = Symbol("OBJECT_STORAGE_CLIENT");
export const OBJECT_STORAGE_PORT = Symbol("OBJECT_STORAGE_PORT");

export type ObjectStorageOptionsToken = typeof OBJECT_STORAGE_OPTIONS;
export type ObjectStorageClientToken = typeof OBJECT_STORAGE_CLIENT;
export type ObjectStoragePortToken = typeof OBJECT_STORAGE_PORT;

export type ObjectStorageOptionsProviderValue = ObjectStorageOptions;
export type ObjectStorageClientProviderValue = ObjectStorageClientPort;
export type ObjectStoragePortProviderValue = ObjectStoragePort;
