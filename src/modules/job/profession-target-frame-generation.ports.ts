/**
 * @fileoverview 定义 Profession V6 单帧生成 Service 依赖的最小 Repository 与图片模型端口；
 * 不执行依赖注入、数据库事务、Provider网络调用或对象存储访问。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-31
 * @relatedPlan N/A - 用户要求执行真实数据测试
 *
 * 调用关系：Generation Service 以这些窄端口声明业务所需能力，生产环境由同模块 Repository 与
 * OpenAiService 实现，测试以mock替代。输入是已校验lease、冻结逐帧上下文和模型证据，输出是有限
 * 领域状态或脱敏ModelCall。副作用由真实实现承担，本文件仅声明类型。
 * 安全边界：模型端口固定artist角色和官方targetDimensions；Repository端口不允许调用方跳过
 * inspect/reserve、beforeEgress绑定、Run配额与原子finalize，也不暴露数据库行或对象定位查询。
 */
import type {
  ImageModelResult,
  ModelCallView,
  ModelImageInput,
} from "../openai/openai.contracts.js";
import type { GenerateProfessionTargetFrameInput } from "./profession-target-frame-generation.contracts.js";
import type {
  FinalizeProfessionTargetFrameOutputInput,
  InspectProfessionTargetFrameGenerationResult,
  ProfessionTargetFrameOutputEvidence,
  ReserveProfessionTargetFrameGenerationResult,
} from "./profession-target-frame-generation.js";

/** Service可调用的最小逐帧事务表面；每个方法仍由真实Repository重新校验当前lease。 */
export interface ProfessionTargetFrameGenerationRepositoryPort {
  inspect(
    jobId: string,
    input: GenerateProfessionTargetFrameInput,
  ): Promise<InspectProfessionTargetFrameGenerationResult>;
  reserve(
    jobId: string,
    input: GenerateProfessionTargetFrameInput,
  ): Promise<ReserveProfessionTargetFrameGenerationResult>;
  bindModelCallBeforeEgress(
    jobId: string,
    targetId: string,
    input: GenerateProfessionTargetFrameInput,
    modelCallId: string,
  ): Promise<"accepted" | "rejected">;
  preparePersistence(
    jobId: string,
    targetId: string,
    input: GenerateProfessionTargetFrameInput,
    evidence: ProfessionTargetFrameOutputEvidence,
    maxRunBytes: number,
  ): Promise<"accepted" | "rejected" | "run-quota-exceeded">;
  finalize(
    jobId: string,
    targetId: string,
    input: GenerateProfessionTargetFrameInput,
    output: FinalizeProfessionTargetFrameOutputInput,
  ): Promise<"accepted" | "rejected">;
  block(
    jobId: string,
    targetId: string,
    input: GenerateProfessionTargetFrameInput,
    errorCode: string,
    modelCallId?: string,
  ): Promise<boolean>;
}

/** Service可调用的固定Artist图片能力；配置和endpoint只能由OpenAiService按Run owner解析。 */
export interface ProfessionTargetFrameImageModelPort {
  image(
    request: {
      runId: string;
      role: "artist";
      prompt: string;
      sourceImage: ModelImageInput;
      targetDimensions: { width: number; height: number };
    },
    beforeEgress?: (record: ModelCallView) => Promise<"accepted" | "rejected">,
  ): Promise<ImageModelResult>;
}
