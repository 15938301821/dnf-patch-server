/**
 * @fileoverview 定义最终候选 NPK 生产 V3 的冻结工具 profile、输入上下文与 Worker 报告；
 * 本文件只校验声明式数据，不启用 package capability，也不接受或执行本机路径与命令。
 * @module modules/job/style-package-production-contracts
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - V2 package fail-closed 后的首个版本化契约切片
 *
 * 调用关系：Package Context Service 从已通过的逐技能证据构造 context，Worker 仅消费
 * context 并按当前 lease/attempt 回填报告；Repository 仍须复核 Artifact 的 Run、上传 attempt
 * 与对象正文。输入输出：输入为 Server 冻结的工具摘要和 finalized Artifact 身份，输出为严格
 * Zod 类型。副作用：无。安全边界：契约不含 executable、命令或路径；四项安全状态恒为 false；
 * schema 存在不代表 Worker 已有封包器、验证器、客户端兼容证据或部署授权。
 */
import { z } from "zod";
import {
  boundedJsonRecordSchema,
  clientIdSchema,
  sha256Schema,
} from "../../common/contracts/index.js";
import { sha256JcsV1 } from "../../common/utils/canonical.js";
import { declarativeParametersSchema } from "../guardrail/guardrail.contracts.js";

/** Package V3 允许的 Job attempt 范围；报告与 Artifact provenance 必须使用同一上限。 */
export const stylePackageAttemptV3Schema = z.number().int().min(1).max(10);
const stablePackageErrorCodeSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Z][A-Z0-9_]*$/u);

/** Worker 不能提升的四项安全结论；候选 NPK 生成成功也不能证明这些状态。 */
export const stylePackageSafetyStateV3Schema = z
  .object({
    deploymentAuthorized: z.literal(false),
    deploymentPerformed: z.literal(false),
    fullSkillCoverageProven: z.literal(false),
    clientCompatibilityProven: z.literal(false),
  })
  .strict();

/** 当前 npk-package Job lease 下读取冻结 context 的完整 fencing 输入。 */
export const requestStylePackageContextV3Schema = z
  .object({
    workerId: z.uuid(),
    leaseId: z.uuid(),
    attempt: stylePackageAttemptV3Schema,
  })
  .strict();

/**
 * 冻结到 package profile 的单个本机工具身份。
 *
 * toolId 是版本化逻辑身份，sha256 是已审查工具文件的完整摘要；本机路径只属于 Worker 环境，
 * 不能进入此契约。
 */
const frozenPackageToolV3Schema = z
  .object({
    toolId: clientIdSchema,
    sha256: sha256Schema,
  })
  .strict();

const frozenDirectXTexV3Schema = z
  .object({
    toolId: clientIdSchema,
    texconvSha256: sha256Schema,
    texdiagSha256: sha256Schema,
  })
  .strict();

const frozenExtractorSharpV3Schema = z
  .object({
    toolId: clientIdSchema,
    coreSha256: sha256Schema,
    jsonSha256: sha256Schema,
    zlibSha256: sha256Schema,
  })
  .strict();

/**
 * 最终候选 NPK V3 的完整工具 profile。
 *
 * 四个角色缺一不可：packager 组装候选 NPK，validator 独立复核包结构，DirectXTex 固定纹理
 * 编码身份，ExtractorSharp 固定 NPK/IMG 解析依赖。这里只冻结身份，不授权 Worker 注册 capability。
 */
export const stylePackageProfileV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    profileId: clientIdSchema,
    outputMediaType: z.literal("application/octet-stream"),
    packager: frozenPackageToolV3Schema,
    validator: frozenPackageToolV3Schema,
    directXTex: frozenDirectXTexV3Schema,
    extractorSharp: frozenExtractorSharpV3Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const toolIds = [
      value.packager.toolId,
      value.validator.toolId,
      value.directXTex.toolId,
      value.extractorSharp.toolId,
    ];
    if (new Set(toolIds).size !== toolIds.length) {
      context.addIssue({
        code: "custom",
        path: ["packager"],
        message:
          "Package V3 的 packager、validator、DirectXTex 与 ExtractorSharp 必须使用不同工具身份。",
      });
    }
  });

const uniquePackageSkillIdsV3Schema = z
  .array(z.uuid())
  .min(1)
  .max(500)
  .refine((values) => new Set(values).size === values.length, {
    message: "Package V3 不能包含重复技能。",
  });

/**
 * Factory contract version 1 下注册的最终候选 NPK 业务 payload V3。
 *
 * 顶层 profileId 必须与 packageProfile.profileId 一致，后续 Job 完整性检查还会要求它匹配
 * 当前 npk-package Job contract 的 profileId。该 payload 只冻结要做什么及工具身份，不包含本机路径、命令或动态 Artifact；
 * 逐技能 Artifact 要等 Profession 阶段完成后由 Server 生成 attempt-bound context。
 */
export const stylePackageProductionJobPayloadV3Schema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: clientIdSchema,
    parameters: z
      .object({
        workflow: z.literal("style-package-production-v3"),
        professionId: z.uuid(),
        styleId: z.uuid(),
        selectedSkillIds: uniquePackageSkillIdsV3Schema,
        packageProfile: stylePackageProfileV3Schema,
        packageProfileSha256: sha256Schema,
        safety: stylePackageSafetyStateV3Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.profileId !== value.parameters.packageProfile.profileId) {
      context.addIssue({
        code: "custom",
        path: ["parameters", "packageProfile", "profileId"],
        message: "Package profile 必须与 Factory Job profile 一致。",
      });
    }
    if (
      sha256JcsV1(value.parameters.packageProfile) !==
      value.parameters.packageProfileSha256.toUpperCase()
    ) {
      context.addIssue({
        code: "custom",
        path: ["parameters", "packageProfileSha256"],
        message: "Package profile SHA-256 与 Job 冻结内容不一致。",
      });
    }
    if (!boundedJsonRecordSchema.safeParse(value).success) {
      context.addIssue({
        code: "custom",
        message: "Package V3 Job 不能超过声明式 JSON 预算。",
      });
    }
    if (!declarativeParametersSchema.safeParse(value.parameters).success) {
      context.addIssue({
        code: "custom",
        path: ["parameters"],
        message: "Package V3 Job 包含不安全的非声明式字段。",
      });
    }
  });

/**
 * 从启动时已完整校验的工具 profile 构造最终候选 NPK 声明式 Job。
 * 动态 Artifact 不进入 payload；它们仅在 Profession 通过后进入 attempt-bound context。
 */
export function createStylePackageProductionJobPayloadV3(input: {
  profileId: string;
  professionId: string;
  styleId: string;
  selectedSkillIds: string[];
  packager: { toolId: string; sha256: string };
  validator: { toolId: string; sha256: string };
  directXTex: {
    toolId: string;
    texconvSha256: string;
    texdiagSha256: string;
  };
  extractorSharp: {
    toolId: string;
    coreSha256: string;
    jsonSha256: string;
    zlibSha256: string;
  };
}): StylePackageProductionJobPayloadV3 {
  const packageProfile = stylePackageProfileV3Schema.parse({
    schemaVersion: 3,
    profileId: input.profileId,
    outputMediaType: "application/octet-stream",
    packager: input.packager,
    validator: input.validator,
    directXTex: input.directXTex,
    extractorSharp: input.extractorSharp,
  });
  return stylePackageProductionJobPayloadV3Schema.parse({
    schemaVersion: 1,
    profileId: input.profileId,
    parameters: {
      workflow: "style-package-production-v3",
      professionId: input.professionId,
      styleId: input.styleId,
      selectedSkillIds: input.selectedSkillIds,
      packageProfile,
      packageProfileSha256: sha256JcsV1(packageProfile),
      safety: {
        deploymentAuthorized: false,
        deploymentPerformed: false,
        fullSkillCoverageProven: false,
        clientCompatibilityProven: false,
      },
    },
  });
}

/** Server 已 finalize 的逐技能 ZIP 证据摘要；正文仍位于私有对象存储。 */
const packageInputArtifactV3Schema = z
  .object({
    artifactId: z.uuid(),
    mediaType: z.literal("application/zip"),
    byteLength: z.number().int().min(1).max(4_294_967_295),
    sha256: sha256Schema,
  })
  .strict();

/** 单个技能进入最终封包阶段的精确工程与验证证据。 */
const stylePackageSkillInputV3Schema = z
  .object({
    skillId: z.uuid(),
    sourceSha256: sha256Schema,
    promptSha256: sha256Schema,
    productionAttempt: stylePackageAttemptV3Schema,
    projectBundle: packageInputArtifactV3Schema,
    validationBundle: packageInputArtifactV3Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.projectBundle.artifactId === value.validationBundle.artifactId) {
      context.addIssue({
        code: "custom",
        path: ["validationBundle", "artifactId"],
        message: "逐技能工程 ZIP 与验证 ZIP 必须使用不同 Artifact。",
      });
    }
  });

/**
 * Server 交给当前 package attempt 的冻结上下文正文。
 *
 * attempt 是同一 Job 的领取轮次；它约束未来 package 输出，逐技能输入可以来自经 Server
 * 接受的更早 attempt，因此每项单独保留 productionAttempt。skills 顺序是最终 manifest 的
 * 权威顺序，不能由 Worker 按名称重排。
 */
export const stylePackageContextV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    workflow: z.literal("style-package-production-v3"),
    jobId: z.uuid(),
    runId: z.uuid(),
    professionId: z.uuid(),
    styleId: z.uuid(),
    attempt: stylePackageAttemptV3Schema,
    packageProfile: stylePackageProfileV3Schema,
    packageProfileSha256: sha256Schema,
    skills: z.array(stylePackageSkillInputV3Schema).min(1).max(500),
    safety: stylePackageSafetyStateV3Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      sha256JcsV1(value.packageProfile) !==
      value.packageProfileSha256.toUpperCase()
    ) {
      context.addIssue({
        code: "custom",
        path: ["packageProfileSha256"],
        message: "Package profile SHA-256 与冻结内容不一致。",
      });
    }
    const skillIds = value.skills.map((skill) => skill.skillId);
    if (new Set(skillIds).size !== skillIds.length) {
      context.addIssue({
        code: "custom",
        path: ["skills"],
        message: "Package context 不能包含重复技能。",
      });
    }
    const artifactIds = value.skills.flatMap((skill) => [
      skill.projectBundle.artifactId,
      skill.validationBundle.artifactId,
    ]);
    if (new Set(artifactIds).size !== artifactIds.length) {
      context.addIssue({
        code: "custom",
        path: ["skills"],
        message: "Package context 中每个逐技能证据必须使用唯一 Artifact。",
      });
    }
  });

/** 带规范化 SHA-256 的 package context；报告必须回填同一摘要以防上下文替换。 */
export const stylePackageContextEnvelopeV3Schema = z
  .object({
    context: stylePackageContextV3Schema,
    contextSha256: sha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (sha256JcsV1(value.context) !== value.contextSha256.toUpperCase()) {
      context.addIssue({
        code: "custom",
        path: ["contextSha256"],
        message: "Package context SHA-256 与冻结内容不一致。",
      });
    }
  });

const packageReportLeaseV3Schema = z.object({
  workerId: z.uuid(),
  leaseId: z.uuid(),
  attempt: stylePackageAttemptV3Schema,
  packageContextSha256: sha256Schema,
  packageProfileSha256: sha256Schema,
});

const activeStylePackageReportV3Schema = packageReportLeaseV3Schema
  .extend({
    status: z.literal("building"),
  })
  .strict();

const passedStylePackageReportV3Schema = packageReportLeaseV3Schema
  .extend({
    status: z.literal("passed"),
    packageArtifactId: z.uuid(),
    packageSha256: sha256Schema,
    manifestArtifactId: z.uuid(),
    manifestSha256: sha256Schema,
    validationArtifactId: z.uuid(),
    validationSha256: sha256Schema,
    safety: stylePackageSafetyStateV3Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const artifactIds = [
      value.packageArtifactId,
      value.manifestArtifactId,
      value.validationArtifactId,
    ];
    if (new Set(artifactIds).size !== artifactIds.length) {
      context.addIssue({
        code: "custom",
        path: ["validationArtifactId"],
        message: "候选 NPK、manifest 与独立验证必须使用不同 Artifact。",
      });
    }
  });

const terminalStylePackageReportV3Schema = packageReportLeaseV3Schema
  .extend({
    status: z.enum(["failed", "blocked"]),
    errorCode: stablePackageErrorCodeSchema,
  })
  .strict();

/**
 * Worker 回填最终 package 阶段的 V3 报告。
 *
 * 通过报告必须同时提交候选 NPK、规范 manifest 和独立验证三个 finalized Artifact；schema
 * 只保证形状，未来 Repository 仍必须证明三者属于当前 run 和当前上传 attempt 后才能落库。
 */
export const reportStylePackageProductionV3Schema = z.discriminatedUnion(
  "status",
  [
    activeStylePackageReportV3Schema,
    passedStylePackageReportV3Schema,
    terminalStylePackageReportV3Schema,
  ],
);

/** 冻结工具 profile 的版本化声明式内容。 */
export type StylePackageProfileV3 = z.infer<typeof stylePackageProfileV3Schema>;
/** 当前 package claim 的 Worker、leaseId 与 attempt，不允许选择 Run、技能或 Artifact。 */
export type RequestStylePackageContextV3 = z.infer<
  typeof requestStylePackageContextV3Schema
>;
/** Factory 冻结并持久化到 npk-package Job 的 V3 声明式 payload。 */
export type StylePackageProductionJobPayloadV3 = z.infer<
  typeof stylePackageProductionJobPayloadV3Schema
>;
/** Server 生成并绑定当前 package attempt 的上下文正文。 */
export type StylePackageContextV3 = z.infer<typeof stylePackageContextV3Schema>;
/** Worker 获取的 package context 与规范化摘要信封。 */
export type StylePackageContextEnvelopeV3 = z.infer<
  typeof stylePackageContextEnvelopeV3Schema
>;
/** Worker 在 package 阶段可提交的互斥报告。 */
export type ReportStylePackageProductionV3 = z.infer<
  typeof reportStylePackageProductionV3Schema
>;

/**
 * 校验 context 后生成规范摘要信封，供 Package Context Service 返回给 Worker。
 *
 * @param input 由 Server 从数据库证据和已配置 package profile 组装的未知输入。
 * @returns 已严格校验且 contextSha256 与正文一致的 V3 信封。
 * @throws ZodError 表示工具 profile、逐技能证据、顺序、哈希或安全状态不满足 V3 契约。
 */
export function createStylePackageContextEnvelopeV3(
  input: unknown,
): StylePackageContextEnvelopeV3 {
  const context = stylePackageContextV3Schema.parse(input);
  return stylePackageContextEnvelopeV3Schema.parse({
    context,
    contextSha256: sha256JcsV1(context),
  });
}
