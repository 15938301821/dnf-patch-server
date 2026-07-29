/**
 * @fileoverview 集中定义 Profession 单技能接收测试共享的稳定 UUID 与数据库时间。
 *
 * 相邻 fixture 和行为测试只把这些值当作可重复身份，不连接 MySQL，也不代表真实 Run、Artifact
 * 或 Worker。集中后仍由各场景构造器决定证据关系，不能用固定值绕过当前 attempt 与归属校验。
 */

/** 行为断言使用的稳定身份与时间；仅用于本地 Vitest fixture。 */
export const skillProductionFixture = {
  jobId: "00000000-0000-4000-8000-000000000000",
  workerId: "11111111-1111-4111-8111-111111111111",
  leaseId: "22222222-2222-4222-8222-222222222222",
  runId: "33333333-3333-4333-8333-333333333333",
  professionId: "44444444-4444-4444-8444-444444444444",
  styleId: "55555555-5555-4555-8555-555555555555",
  skillId: "66666666-6666-4666-8666-666666666666",
  sourceRunId: "77777777-7777-4777-8777-777777777777",
  sourceInventoryId: "88888888-8888-4888-8888-888888888888",
  sourceManifestArtifactId: "99999999-9999-4999-8999-999999999999",
  sourceVisualArtifactId: "91919191-9191-4191-8191-919191919191",
  engineerModelCallId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  artistModelCallId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  engineerArtifactId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  referenceArtifactId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  imageAttemptId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  projectsArtifactId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  validationArtifactId: "10101010-1010-4010-8010-101010101010",
  sourcePreviewArtifactId: "11111111-2222-4111-8111-111111111111",
  resultPreviewArtifactId: "12121212-2222-4212-8212-121212121212",
  projectsUploadId: "20202020-2020-4020-8020-202020202020",
  validationUploadId: "30303030-3030-4030-8030-303030303030",
  sourcePreviewUploadId: "31313131-3131-4131-8131-313131313131",
  resultPreviewUploadId: "32323232-3232-4232-8232-323232323232",
  now: new Date("2026-07-24T00:00:00.000Z"),
} as const;
