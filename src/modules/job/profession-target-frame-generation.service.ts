/**
 * @fileoverview 编排 Profession V6 单帧官方PNG复读、真实图片模型出站、同尺寸/同Alpha正规化、
 * 私有对象持久化与Artifact终态；不执行Aseprite、NPK封包、部署或客户端兼容判定。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-31
 * @relatedPlan N/A - 用户要求执行真实数据测试
 *
 * 调用关系：内部Worker Controller提交当前lease和帧坐标；Service先inspect并在状态变更前复读官方
 * PNG，再reserve唯一出站权。OpenAiService从Run owner解析用户图片模型配置，beforeEgress回调绑定
 * ModelCall；成功字节交给正规化器，随后Repository保留Run配额、ObjectStorage写入并原子finalize。
 * 输入不含Prompt、模型、endpoint或对象key；输出只含in-progress/passed/blocked和passed Artifact摘要。
 * 副作用：可能读取/写入私有对象、调用一次用户图片模型并更新ModelCall/Artifact/ImageAttempt/目标行。
 * 安全边界：官方源复读失败发生在reserve前，可安全重试；reserved/egressing绝不自动重放模型；
 * persisting只复读确定性对象。passed仍明确禁止直接运行时使用、封包、兼容或部署推断。
 */
import {
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ObjectStorageEvidence,
  ObjectStoragePort,
} from "../../common/storage/object-storage.client.js";
import { OBJECT_STORAGE_PORT } from "../../common/storage/object-storage.tokens.js";
import { sha256JcsV1 } from "../../common/utils/canonical.js";
import {
  ARTIFACT_UPLOAD_OPTIONS,
  type ArtifactUploadOptions,
} from "../artifact/artifact.tokens.js";
import type {
  ImageModelResult,
  ModelImageInput,
} from "../openai/openai.contracts.js";
import { OpenAiService } from "../openai/openai.service.js";
import {
  normalizeProfessionTargetFrame,
  ProfessionTargetFrameImageError,
} from "./profession-target-frame-image.js";
import {
  professionTargetFrameNormalizationAlgorithm,
  professionTargetFrameOutputProvenanceSchema,
  type GenerateProfessionTargetFrameInput,
  type ProfessionTargetFrameGenerationView,
} from "./profession-target-frame-generation.contracts.js";
import { ProfessionTargetFrameGenerationRepository } from "./profession-target-frame-generation.repository.js";
import {
  createProfessionTargetFramePrompt,
  isProfessionTargetFrameGenerationView as isGenerationView,
  parseProfessionTargetFrameGenerationView as parseView,
  professionTargetFrameAdapterIdentity as adapterIdentity,
  professionTargetFrameGenerationConfigSha256 as targetFrameGenerationConfigSha256,
  professionTargetFrameLogicalName as targetFrameLogicalName,
  professionTargetFrameModelErrorCode as stableModelErrorCode,
  professionTargetFramePromptSha256 as promptSha256,
  targetFrameObjectKey,
  throwProfessionTargetFrameGenerationFailure as throwGenerationFailure,
  throwProfessionTargetFramePersistenceUnavailable as throwPersistenceUnavailable,
  throwProfessionTargetFrameStateConflict as throwStateConflict,
} from "./profession-target-frame-generation.service-support.js";
import type {
  InspectProfessionTargetFrameGenerationResult,
  ProfessionTargetFrameGenerationContext,
  ProfessionTargetFrameOutputEvidence,
} from "./profession-target-frame-generation.js";
import type {
  ProfessionTargetFrameGenerationRepositoryPort,
  ProfessionTargetFrameImageModelPort,
} from "./profession-target-frame-generation.ports.js";
import {
  ProfessionTargetFrameSourceImageError,
  verifyProfessionTargetFrameSourceImage,
} from "./profession-target-frame-source-image.js";

const imageMediaType = "image/png" as const;

export {
  createProfessionTargetFramePrompt,
  targetFrameObjectKey,
} from "./profession-target-frame-generation.service-support.js";

@Injectable()
/** 单帧真实生成的业务所有者；把事务、模型和对象存储按不可重复出站顺序串联。 */
export class ProfessionTargetFrameGenerationService {
  constructor(
    @Inject(ProfessionTargetFrameGenerationRepository)
    private readonly generations: ProfessionTargetFrameGenerationRepositoryPort,
    @Inject(OpenAiService)
    private readonly models: ProfessionTargetFrameImageModelPort,
    @Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort,
    @Inject(ARTIFACT_UPLOAD_OPTIONS)
    private readonly artifactOptions: ArtifactUploadOptions,
  ) {}

  /**
   * 生成或恢复一个已prepared且已登记官方PNG的可见帧。
   * @returns 严格Worker View；passed只表示目标PNG与数据库/对象证据完成，不表示封包或Job通过。
   */
  async generate(
    jobId: string,
    input: GenerateProfessionTargetFrameInput,
  ): Promise<ProfessionTargetFrameGenerationView> {
    const inspected = await this.generations.inspect(jobId, input);
    if (isGenerationView(inspected)) return parseView(inspected);
    if (inspected.status === "persistence-pending") {
      return this.recoverPersistence(jobId, input, inspected);
    }
    if (inspected.status !== "new") throwGenerationFailure(inspected);

    // 官方PNG在取得出站权之前复读；MinIO暂时故障不会留下reserved状态或迫使模型重放。
    const sourceImage = await this.readAndVerifySource(inspected.generation);
    const reservation = await this.generations.reserve(jobId, input);
    if (isGenerationView(reservation)) return parseView(reservation);
    if (reservation.status === "persistence-pending") {
      return this.recoverPersistence(jobId, input, reservation);
    }
    if (reservation.status !== "execute") {
      throwGenerationFailure(reservation);
    }
    if (!isDeepStrictEqual(inspected.generation, reservation.generation)) {
      throw new ConflictException({
        code: "PROFESSION_TARGET_FRAME_SOURCE_CHANGED",
        message: "模型出站前的官方逐帧输入证据发生变化。",
      });
    }

    return this.executeModel(jobId, input, reservation.generation, sourceImage);
  }

  /** 只在reserve返回execute时调用；通过回调把running ModelCall绑定到唯一目标行。 */
  private async executeModel(
    jobId: string,
    input: GenerateProfessionTargetFrameInput,
    generation: ProfessionTargetFrameGenerationContext,
    sourceImage: ModelImageInput,
  ): Promise<ProfessionTargetFrameGenerationView> {
    const prompt = createProfessionTargetFramePrompt(generation);
    let boundModelCallId: string | undefined;
    let result: ImageModelResult;
    try {
      result = await this.models.image(
        {
          runId: generation.runId,
          role: "artist",
          prompt,
          sourceImage,
          targetDimensions: {
            width: generation.target.width,
            height: generation.target.height,
          },
        },
        async (record) => {
          const bound = await this.generations.bindModelCallBeforeEgress(
            jobId,
            generation.targetId,
            input,
            record.id,
          );
          if (bound === "accepted") boundModelCallId = record.id;
          return bound;
        },
      );
    } catch {
      return this.block(
        jobId,
        input,
        generation,
        "PROFESSION_TARGET_FRAME_MODEL_EXECUTION_FAILED",
        boundModelCallId,
      );
    }
    if (
      result.record.status !== "passed" ||
      !result.bytes ||
      !result.targetGeometry
    ) {
      return this.block(
        jobId,
        input,
        generation,
        stableModelErrorCode(result.record.errorCode),
        boundModelCallId,
      );
    }
    if (boundModelCallId !== result.record.id) {
      return this.block(
        jobId,
        input,
        generation,
        "PROFESSION_TARGET_FRAME_MODEL_BINDING_MISMATCH",
        boundModelCallId,
      );
    }

    let normalized: Awaited<ReturnType<typeof normalizeProfessionTargetFrame>>;
    try {
      normalized = await normalizeProfessionTargetFrame({
        sourcePng: sourceImage.bytes,
        providerPng: result.bytes,
        sourceAlphaSha256: generation.target.sourceAlphaSha256,
        geometry: result.targetGeometry,
      });
    } catch (error) {
      if (!(error instanceof ProfessionTargetFrameImageError)) throw error;
      return this.block(jobId, input, generation, error.code, result.record.id);
    }
    if (
      normalized.width !== generation.target.width ||
      normalized.height !== generation.target.height ||
      normalized.alphaSha256 !== generation.target.sourceAlphaSha256
    ) {
      return this.block(
        jobId,
        input,
        generation,
        "PROFESSION_TARGET_FRAME_NORMALIZATION_MISMATCH",
        result.record.id,
      );
    }

    const evidence: ProfessionTargetFrameOutputEvidence = {
      modelCallId: result.record.id,
      outputSha256: normalized.sha256,
      outputByteLength: normalized.bytes.byteLength,
      normalizationAlgorithm: normalized.algorithm,
    };
    const prepared = await this.generations.preparePersistence(
      jobId,
      generation.targetId,
      input,
      evidence,
      this.artifactOptions.maxRunBytes,
    );
    if (prepared === "run-quota-exceeded") {
      return this.block(
        jobId,
        input,
        generation,
        "PROFESSION_TARGET_FRAME_RUN_QUOTA_EXCEEDED",
        result.record.id,
      );
    }
    if (prepared !== "accepted") throwStateConflict();

    let stored: ObjectStorageEvidence;
    try {
      stored = await this.storage.write({
        objectKey: targetFrameObjectKey(generation.targetId),
        mediaType: imageMediaType,
        bytes: normalized.bytes,
        sha256: normalized.sha256,
      });
    } catch {
      throwPersistenceUnavailable();
    }
    return this.finalize(jobId, input, generation, evidence, stored, prompt);
  }

  /** persisting重试只完整复读确定性对象，不再读取源图或调用模型。 */
  private async recoverPersistence(
    jobId: string,
    input: GenerateProfessionTargetFrameInput,
    pending: Extract<
      InspectProfessionTargetFrameGenerationResult,
      { status: "persistence-pending" }
    >,
  ): Promise<ProfessionTargetFrameGenerationView> {
    let stored: ObjectStorageEvidence;
    try {
      stored = await this.storage.verify({
        objectKey: targetFrameObjectKey(pending.generation.targetId),
        expectedMediaType: imageMediaType,
        expectedByteLength: pending.outputByteLength,
        expectedSha256: pending.outputSha256,
      });
    } catch {
      throwPersistenceUnavailable();
    }
    return this.finalize(
      jobId,
      input,
      pending.generation,
      {
        modelCallId: pending.modelCallId,
        outputSha256: pending.outputSha256,
        outputByteLength: pending.outputByteLength,
        normalizationAlgorithm: professionTargetFrameNormalizationAlgorithm,
      },
      stored,
      createProfessionTargetFramePrompt(pending.generation),
    );
  }

  /** 校验对象回执后创建新的Artifact/ImageAttempt标识并提交同一数据库事务。 */
  private async finalize(
    jobId: string,
    input: GenerateProfessionTargetFrameInput,
    generation: ProfessionTargetFrameGenerationContext,
    expected: ProfessionTargetFrameOutputEvidence,
    stored: ObjectStorageEvidence,
    prompt: string,
  ): Promise<ProfessionTargetFrameGenerationView> {
    if (
      stored.objectKey !== targetFrameObjectKey(generation.targetId) ||
      stored.mediaType !== imageMediaType ||
      stored.byteLength !== expected.outputByteLength ||
      stored.sha256.toUpperCase() !== expected.outputSha256.toUpperCase()
    ) {
      throwPersistenceUnavailable();
    }
    const artifactId = randomUUID();
    const imageAttemptId = randomUUID();
    const generationConfigSha256 =
      targetFrameGenerationConfigSha256(generation);
    const provenance = professionTargetFrameOutputProvenanceSchema.parse({
      schemaVersion: 1,
      kind: "profession-target-frame-output-v1",
      jobId,
      runId: generation.runId,
      attempt: input.attempt,
      skillId: input.skillId,
      entryIndex: input.entryIndex,
      frameIndex: input.frameIndex,
      sourceArtifactId: generation.sourceImage.artifactId,
      sourceSha256: generation.target.sourceSha256,
      sourceAlphaSha256: generation.target.sourceAlphaSha256,
      width: generation.target.width,
      height: generation.target.height,
      modelCallId: expected.modelCallId,
      imageAttemptId,
      generationConfigSha256,
      normalizationAlgorithm: expected.normalizationAlgorithm,
      safety: {
        sourceGeometryPreserved: true,
        sourceAlphaPreserved: true,
        targetDimensionsEqualSource: true,
        directRuntimeUseAllowed: false,
        deploymentAuthorized: false,
        deploymentPerformed: false,
        fullSkillCoverageProven: false,
        clientCompatibilityProven: false,
      },
    });
    const finalized = await this.generations.finalize(
      jobId,
      generation.targetId,
      input,
      {
        ...expected,
        artifactId,
        imageAttemptId,
        storageKey: stored.objectKey,
        logicalName: targetFrameLogicalName(input),
        mediaType: imageMediaType,
        promptSha256: promptSha256(prompt, generation),
        inputSnapshotSha256: sha256JcsV1({
          schemaVersion: 1,
          sourceArtifactId: generation.sourceImage.artifactId,
          sourceSha256: generation.target.sourceSha256,
          sourceAlphaSha256: generation.target.sourceAlphaSha256,
          skillId: input.skillId,
          entryIndex: input.entryIndex,
          frameIndex: input.frameIndex,
          width: generation.target.width,
          height: generation.target.height,
        }),
        generationConfigSha256,
        adapterIdentity,
        provenance,
      },
    );
    if (finalized !== "accepted") throwStateConflict();
    return parseView({
      schemaVersion: 1,
      status: "passed",
      skillId: input.skillId,
      entryIndex: input.entryIndex,
      frameIndex: input.frameIndex,
      modelCallId: expected.modelCallId,
      imageAttemptId,
      targetArtifactId: artifactId,
      mediaType: imageMediaType,
      width: generation.target.width,
      height: generation.target.height,
      byteLength: stored.byteLength,
      sha256: stored.sha256.toUpperCase(),
      sourceAlphaSha256: generation.target.sourceAlphaSha256,
      normalizationAlgorithm: expected.normalizationAlgorithm,
    });
  }

  /** 从Repository提供的受控声明读取官方PNG，并再次验证Artifact、尺寸和逐像素Alpha。 */
  private async readAndVerifySource(
    generation: ProfessionTargetFrameGenerationContext,
  ): Promise<ModelImageInput> {
    let stored: Awaited<ReturnType<ObjectStoragePort["readVerifiedBytes"]>>;
    try {
      stored = await this.storage.readVerifiedBytes({
        objectKey: generation.sourceImage.objectKey,
        expectedMediaType: generation.sourceImage.expectedMediaType,
        expectedByteLength: generation.sourceImage.expectedByteLength,
        expectedSha256: generation.sourceImage.expectedSha256,
        maxByteLength: generation.sourceImage.maxByteLength,
      });
    } catch {
      throw new ServiceUnavailableException({
        code: "PROFESSION_TARGET_FRAME_SOURCE_UNAVAILABLE",
        message: "官方逐帧PNG暂时无法完成模型出站前复读。",
      });
    }
    if (
      stored.objectKey !== generation.sourceImage.objectKey ||
      stored.mediaType !== imageMediaType ||
      stored.byteLength !== generation.sourceImage.expectedByteLength ||
      stored.sha256.toUpperCase() !== generation.target.sourceSha256
    ) {
      throw new ConflictException({
        code: "PROFESSION_TARGET_FRAME_SOURCE_ARTIFACT_MISMATCH",
        message: "官方逐帧PNG的对象证据发生漂移。",
      });
    }
    try {
      await verifyProfessionTargetFrameSourceImage(stored.bytes, {
        width: generation.target.width,
        height: generation.target.height,
        sourceAlphaSha256: generation.target.sourceAlphaSha256,
      });
    } catch (error) {
      if (error instanceof ProfessionTargetFrameSourceImageError) {
        throw new ConflictException({
          code: error.code,
          message: "官方逐帧PNG的尺寸或Alpha证据不可信。",
        });
      }
      throw error;
    }
    return {
      role: "official-source",
      mediaType: imageMediaType,
      bytes: stored.bytes,
      sha256: stored.sha256.toUpperCase(),
    };
  }

  /** 持久化永久阻断并返回严格blocked View；无法提交终态时按状态冲突关闭。 */
  private async block(
    jobId: string,
    input: GenerateProfessionTargetFrameInput,
    generation: ProfessionTargetFrameGenerationContext,
    errorCode: string,
    modelCallId?: string,
  ): Promise<ProfessionTargetFrameGenerationView> {
    const persisted = await this.generations.block(
      jobId,
      generation.targetId,
      input,
      errorCode,
      modelCallId,
    );
    if (!persisted) throwStateConflict();
    return parseView({
      schemaVersion: 1,
      status: "blocked",
      skillId: input.skillId,
      entryIndex: input.entryIndex,
      frameIndex: input.frameIndex,
      errorCode,
    });
  }
}
