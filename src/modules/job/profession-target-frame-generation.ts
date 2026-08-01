/**
 * @fileoverview 定义 Profession V6 单帧生成在 Service 与 Repository 之间流转的领域状态；
 * 不执行 HTTP 校验、数据库事务、模型调用或对象存储访问，也不作为 Worker 响应直接暴露。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-31
 * @relatedPlan N/A - 用户要求执行真实数据测试
 *
 * 调用关系：Generation Repository 生产 inspect/reserve 结果，Generation Service 消费这些结果并
 * 生成持久化输入。输入已绑定当前 lease、冻结帧与服务端模型证据；输出是严格判别联合和内部上下文。
 * 副作用：本文件仅声明类型。安全边界：内部上下文可携带对象读取声明，但不得穿过 Controller；
 * Worker ViewModel、数据库行和对象定位保持分离，避免把 Prompt、路径或存储 key 暴露给 Worker。
 */
import type { ObjectStorageVerifiedReadRequest } from "../../common/storage/object-storage.client.js";
import type { FrozenProfessionSkillExecutionContext } from "./profession-execution-context.js";
import type { ResolveProfessionExecutionContextResult } from "./profession-execution-context.js";
import type {
  professionTargetFrameNormalizationAlgorithm,
  ProfessionTargetFrameOutputProvenance,
  ProfessionTargetFrameGenerationView,
} from "./profession-target-frame-generation.contracts.js";

type GateFailure = Exclude<
  ResolveProfessionExecutionContextResult,
  { status: "accepted" }
>;

/** 生成入口可向Controller映射的有限失败；不包含表名、对象key、Prompt或Provider错误正文。 */
export type ProfessionTargetFrameGenerationFailure =
  | GateFailure
  | { status: "job-contract-mismatch" }
  | { status: "target-frame-not-found" }
  | { status: "target-frame-integrity-failed" }
  | { status: "source-frame-not-ready" }
  | { status: "generation-state-conflict" };

/** execute/persistence-pending 共用的已冻结单帧内部事实，不可返回Worker。 */
export interface ProfessionTargetFrameGenerationContext {
  targetId: string;
  runId: string;
  context: FrozenProfessionSkillExecutionContext;
  sourceImage: ObjectStorageVerifiedReadRequest & {
    artifactId: string;
  };
  target: {
    entryIndex: number;
    frameIndex: number;
    width: number;
    height: number;
    sourceSha256: string;
    sourceAlphaSha256: string;
  };
}

/** reserve 是唯一授予模型出站权的事务；其他非终态只能观察或恢复对象持久化。 */
export type ReserveProfessionTargetFrameGenerationResult =
  | ProfessionTargetFrameGenerationFailure
  | { status: "execute"; generation: ProfessionTargetFrameGenerationContext }
  | {
      status: "persistence-pending";
      generation: ProfessionTargetFrameGenerationContext;
      modelCallId: string;
      outputSha256: string;
      outputByteLength: number;
    }
  | ProfessionTargetFrameGenerationView;

/** inspect 不改变状态；new 表示可先复读官方PNG，随后仍须reserve竞争唯一出站权。 */
export type InspectProfessionTargetFrameGenerationResult =
  | ProfessionTargetFrameGenerationFailure
  | { status: "new"; generation: ProfessionTargetFrameGenerationContext }
  | {
      status: "persistence-pending";
      generation: ProfessionTargetFrameGenerationContext;
      modelCallId: string;
      outputSha256: string;
      outputByteLength: number;
    }
  | ProfessionTargetFrameGenerationView;

/** preparePersistence 只接受模型终态与正规化目标摘要。 */
export interface ProfessionTargetFrameOutputEvidence {
  modelCallId: string;
  outputSha256: string;
  outputByteLength: number;
  normalizationAlgorithm: typeof professionTargetFrameNormalizationAlgorithm;
}

/** finalize 的全部服务端事实；对象定位不会进入HTTP响应或Worker协议。 */
export interface FinalizeProfessionTargetFrameOutputInput extends ProfessionTargetFrameOutputEvidence {
  artifactId: string;
  imageAttemptId: string;
  storageKey: string;
  logicalName: string;
  mediaType: "image/png";
  promptSha256: string;
  inputSnapshotSha256: string;
  generationConfigSha256: string;
  adapterIdentity: string;
  provenance: ProfessionTargetFrameOutputProvenance;
}
