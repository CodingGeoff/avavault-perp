/**
 * 参考价解析（纯函数，独立成模块便于单测）。
 *
 * 背景：/hedge/quote 需要一个"参考价"把资产估值换算成合约数量。以前只有一条链：
 *   显式传入 > 标记价预言机 > 盘口最优卖价 > 盘口最优买价，
 * 全都拿不到时直接 503 "no reference price available"。这在**刚重置过、盘口空、
 * 还没有任何成交、也没配外部喂价**的演示环境里必然发生——前端只弹一行英文错误，
 * 演示流程当场卡死（真实发生过：彩排时连点三次都是这个错）。
 *
 * 现在的规则：
 *   1. 显式传入的参考价优先（用户/前端填的），来源标记 explicit-input；
 *   2. 标记价预言机（外部喂价 > 成交 TWAP > 最新成交价），来源沿用预言机自报的 source；
 *   3. 盘口最优卖价 / 最优买价；
 *   4. 以上都没有时，用部署方配置的兜底参考价（HEDGE_FALLBACK_REF_PRICE），
 *      来源标记 config-fallback —— **明确标注它是配置值而不是市场数据**，
 *      前端会如实显示"参考价来源：配置兜底值"，不假装这是链上/盘口读出来的价；
 *   5. 连兜底都没配（空字符串）时返回 null，并附带一份"缺什么、怎么补"的诊断，
 *      让调用方能把可执行的提示返回给前端，而不是一句 no reference price available。
 */

/** 参考价来源 -> 人类可读说明（前端直接展示，中/英各一份） */
export const REF_PRICE_SOURCE_LABELS = {
  "explicit-input": { zh: "调用方显式指定", en: "explicitly provided" },
  "external-feed": { zh: "外部喂价", en: "external price feed" },
  "trade-twap": { zh: "成交 TWAP", en: "trade TWAP" },
  "last-trade": { zh: "最新成交价（样本不足兜底）", en: "last trade (insufficient TWAP samples)" },
  "book-best-ask": { zh: "盘口最优卖价", en: "best ask" },
  "book-best-bid": { zh: "盘口最优买价", en: "best bid" },
  "config-fallback": { zh: "服务端配置兜底值（非市场数据）", en: "server config fallback (not market data)" },
  unavailable: { zh: "不可用", en: "unavailable" },
};

/** 参考价不可用时的诊断：每一层为什么没有，以及补上它的最小动作 */
export function buildRefPriceDiagnostics({ markFeedConfigured, markPriceAvailable = false, tradeSampleCount, bookDepth, fallbackConfigured }) {
  const missing = [];
  if (!markFeedConfigured) {
    missing.push({
      layer: "external-feed",
      reason: "MARK_PRICE_FEED_URL not configured",
      fix: "set MARK_PRICE_FEED_URL to a JSON price feed (e.g. {\"price\":2500})",
    });
  } else if (!markPriceAvailable) {
    missing.push({
      layer: "external-feed",
      reason: "MARK_PRICE_FEED_URL is configured but did not return a usable price",
      fix: "check that the URL is reachable from the server and returns a positive JSON price (e.g. {\"price\":2500})",
    });
  }
  if (!tradeSampleCount) {
    missing.push({
      layer: "trade-twap",
      reason: "no trades yet, so the mark TWAP has no samples",
      fix: "seed the book and cross a few orders (demo/seed_counterparty.mjs), or place any order that fills",
    });
  }
  if (!bookDepth) {
    missing.push({
      layer: "order-book",
      reason: "order book is empty (no resting bids/asks)",
      fix: "run demo/seed_counterparty.mjs, POST /admin/seed-book, or place a limit order",
    });
  }
  if (!fallbackConfigured) {
    missing.push({
      layer: "config-fallback",
      reason: "HEDGE_FALLBACK_REF_PRICE not configured",
      fix: "set HEDGE_FALLBACK_REF_PRICE, or pass referencePrice explicitly in the request",
    });
  }
  return missing;
}

/**
 * @param {object} input
 * @param {bigint|null|undefined} input.explicit   请求里显式传入的参考价
 * @param {{price:bigint,source:string}|null|undefined} input.mark 标记价预言机结果
 * @param {bigint|null|undefined} input.bestAsk    盘口最优卖价
 * @param {bigint|null|undefined} input.bestBid    盘口最优买价
 * @param {bigint|null|undefined} input.fallback   部署方配置的兜底参考价
 * @returns {{price:bigint|null, source:string, marketData:boolean}}
 *          marketData=false 表示这个价格不是从喂价/盘口/成交读来的（explicit 或 fallback）
 */
export function resolveReferencePrice({ explicit = null, mark = null, bestAsk = null, bestBid = null, fallback = null }) {
  const positive = (v) => (v === null || v === undefined ? null : BigInt(v) > 0n ? BigInt(v) : null);

  const explicitValue = positive(explicit);
  if (explicitValue !== null) return { price: explicitValue, source: "explicit-input", marketData: false };

  const markValue = mark ? positive(mark.price) : null;
  if (markValue !== null) return { price: markValue, source: mark.source || "mark-oracle", marketData: true };

  const ask = positive(bestAsk);
  if (ask !== null) return { price: ask, source: "book-best-ask", marketData: true };

  const bid = positive(bestBid);
  if (bid !== null) return { price: bid, source: "book-best-bid", marketData: true };

  const fallbackValue = positive(fallback);
  if (fallbackValue !== null) return { price: fallbackValue, source: "config-fallback", marketData: false };

  return { price: null, source: "unavailable", marketData: false };
}
