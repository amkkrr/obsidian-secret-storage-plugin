/**
 * RFC-002 §8.1 单元测试：filterSecretIds（密钥 ID 过滤纯函数）
 * 纯函数位于 src/search.ts，不依赖 obsidian 运行时。
 */
import { describe, it, expect } from "vitest";
import { filterSecretIds } from "../src/search";

describe("filterSecretIds", () => {
  const ids = [
    "openai-api-key",
    "anthropic-key",
    "github-token",
    "aws-secret",
    "openai-org-id"
  ];

  it("空 query 返回全部", () => {
    expect(filterSecretIds(ids, "")).toEqual(ids);
    expect(filterSecretIds(ids, "   ")).toEqual(ids);
    expect(filterSecretIds(ids, null)).toEqual(ids);
    expect(filterSecretIds(ids, undefined)).toEqual(ids);
  });

  it("全字匹配仅命中", () => {
    expect(filterSecretIds(ids, "github-token")).toEqual(["github-token"]);
  });

  it("子串/分词部分命中", () => {
    expect(filterSecretIds(ids, "openai")).toEqual([
      "openai-api-key",
      "openai-org-id"
    ]);
  });

  it("大小写不敏感", () => {
    expect(filterSecretIds(ids, "OPENAI")).toEqual([
      "openai-api-key",
      "openai-org-id"
    ]);
    expect(filterSecretIds(ids, "Github")).toEqual(["github-token"]);
  });

  it("无匹配返回空数组", () => {
    expect(filterSecretIds(ids, "nonexistent")).toEqual([]);
  });

  it("空数组输入返回空数组", () => {
    expect(filterSecretIds([], "openai")).toEqual([]);
  });

  it("自定义 matcher 生效", () => {
    // 用自定义 matcher 模拟 prepareSimpleSearch 的分词行为
    const matcher = (text) => text.includes("openai");
    expect(filterSecretIds(ids, "openai", matcher)).toEqual([
      "openai-api-key",
      "openai-org-id"
    ]);
  });
});
