import { TwapMarkPrice } from "../../matching-engine/dist/markPrice.js";

/**
 * 标记价来源组合（独立于最新成交价，避免单笔成交猎杀强平线）：
 *   1. 外部喂价（MARK_PRICE_FEED_URL，返回 {"price": 2500} 或纯数字 JSON）——配了且可用时优先；
 *   2. 成交 TWAP（TwapMarkPrice 对窗口内成交做时间加权，单笔瞬时价格拉不动）；
 *   3. 最新成交价（样本不足时的兜底，返回值里会如实标注 source）。
 * 任何一层失败都向下退，绝不因为喂价接口抖动让强平系统停摆。
 */
export class MarkOracle {
  constructor({ windowMs = 5 * 60 * 1000, feedUrl = "", feedCacheMs = 10_000, feedTimeoutMs = 3000 } = {}) {
    this.twap = new TwapMarkPrice({ windowMs });
    this.feedUrl = feedUrl;
    this.feedCacheMs = feedCacheMs;
    this.feedTimeoutMs = feedTimeoutMs;
    this.feedCache = null; // { price: bigint, at: number }
  }

  addTradeSample(price, timestamp = Date.now()) {
    this.twap.addSample(BigInt(price), timestamp);
  }

  async fetchFeedPrice() {
    if (this.feedCache && Date.now() - this.feedCache.at < this.feedCacheMs) {
      return this.feedCache.price;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.feedTimeoutMs);
    try {
      const res = await fetch(this.feedUrl, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
      const data = await res.json();
      const raw = typeof data === "number" ? data : data.price;
      const price = BigInt(Math.trunc(Number(raw)));
      if (price <= 0n) throw new Error("feed returned a non-positive price");
      this.feedCache = { price, at: Date.now() };
      return price;
    } finally {
      clearTimeout(timer);
    }
  }

  /** @returns {Promise<{price: bigint, source: string}|null>} */
  async getMark() {
    if (this.feedUrl) {
      try {
        return { price: await this.fetchFeedPrice(), source: "external-feed" };
      } catch {
        // 喂价失败不致命：退回成交 TWAP
      }
    }
    const now = Date.now();
    const twap = this.twap.getMark(now);
    if (twap !== null) return { price: twap, source: "trade-twap" };
    const latest = this.twap.latest();
    if (latest !== null) return { price: latest, source: "last-trade" };
    return null;
  }
}
