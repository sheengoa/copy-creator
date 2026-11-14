/** 代理地址校验（画布 AI 渠道/全局默认代理共用，与后端 normalize_proxy
 *  同语义）：空 = 不走代理（回退全局默认）；非空须 http(s):// 或
 *  socks5(h):// 前缀且可解析为 URL——存前先拦，免得生成/测速时才报
 *  「HTTP 客户端初始化失败」这种不指因的错误。 */
export const isValidProxy = (raw: string): boolean => {
  const value = raw.trim();
  if (value === "") return true;
  if (!/^(https?|socks5h?):\/\//i.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};
