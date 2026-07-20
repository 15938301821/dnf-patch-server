import { z } from "zod";

export const idSchema = z.uuid();
export const clientIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u);
export const sha256Schema = z.string().regex(/^[A-Fa-f0-9]{64}$/u);
export const safeDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((value) => !hasUnsafeDisplayNameCharacter(value), {
    message: "名称包含不安全字符。",
  });
export const repositoryRelativePathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/^[A-Za-z]:/u.test(value) &&
      !value.replaceAll("\\", "/").split("/").includes(".."),
    { message: "必须提供安全的仓库相对路径。" },
  );

function hasUnsafeDisplayNameCharacter(value: string): boolean {
  if (/[<>:"/\\|?*]/u.test(value)) {
    return true;
  }
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint <= 0x1f;
  });
}
