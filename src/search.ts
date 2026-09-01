/**
 * RFC-002 §5.1 密钥 ID 搜索纯函数。
 * 不依赖 obsidian 运行时，便于单元测试。
 */

/**
 * 过滤密钥 ID 列表。
 * query 为空时返回全部；否则用 matcher 做大小写不敏感匹配。
 * @param {string[]} ids 密钥 ID 列表
 * @param {string} query 搜索关键词
 * @param {(text: string) => boolean} [matcher] 匹配回调（默认子串 includes，大小写不敏感）
 * @returns {string[]} 过滤后的 ID 列表
 */
export function filterSecretIds(ids, query, matcher = null) {
  if (!query || query.trim() === "") {
    return ids;
  }
  const q = query.trim().toLowerCase();
  const match = matcher || ((text) => text.includes(q));
  return ids.filter((id) => match(id.toLowerCase()));
}
