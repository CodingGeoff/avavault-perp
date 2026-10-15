import { TwapMarkPrice } from "../../matching-engine/dist/markPrice.js";

/**
 * 解析外部喂价的常见返回形状，统一成系统价格单位（整数，向上层截断小数）：
 *   - 纯数字 / {"price": 2500} / {"price": "2500.5"}（自建喂价、Binance 风格）
 *   - {"avalanche-2": {"usd": 35.2}}（CoinGecko /simple/price 风格，取第一个 usd 字段）
 * 解析不出正数时抛错，调用方按"喂价不可用"退回成交 TWAP，不会把脏数据喂给强平。
 */
export function parseFeedPrice(data) {
  let raw = NaN;
  if (typeof data === "number") raw = data;
  else if (data && typeof data === "object") {
    if (data.price !== undefined) raw = Number(data.price);
    else {
      for (const v of Object.values(data)) {
        if (v && typeof v === "object" && v.usd !== undefined) { raw = Number(v.usd); break; }
      }
    }
  }
  const price = BigInt(Math.trunc(raw));
  if (!(price > 0n)) throw new Error("feed returned a non-positive or unparsable price");
  return price;
}

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

  /** 清空成交样本与喂价缓存（演示彩排重置用） */
  reset() {
    this.twap.reset();
    this.feedCache = null;
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
      const price = parseFeedPrice(data);
      this.feedCache = { price, at: Date.now() };
      return price;
    } finally {
      clearTimeout(timer);
    }
  }

  /** @returns {Promise<{price: bigint, source: string, asOf: number|null, stale: boolean}|null>} */
  async getMark() {
    if (this.feedUrl) {
      try {
        const price = await this.fetchFeedPrice();
        return { price, source: "external-feed", asOf: this.feedCache?.at ?? null, stale: false };
      } catch {
        // 喂价失败不致命：退回成交 TWAP
      }
    }
    const now = Date.now();
    const asOf = this.twap.latestTimestamp();
    const stale = asOf !== null && now - asOf > this.twap.windowMs;
    const twap = this.twap.getMark(now);
    if (twap !== null) return { price: twap, source: "trade-twap", asOf, stale };
    const latest = this.twap.latest();
    if (latest !== null) return { price: latest, source: "last-trade", asOf, stale };
    return null;
  }

  /** 独立指数价：只认外部喂价；没有配置/不可用时返回 null（调用方不应硬造资金费） */
  async getIndexPrice() {
    if (!this.feedUrl) return null;
    try {
      return await this.fetchFeedPrice();
    } catch {
      return null;
    }
  }

  /**
   * 资金费输入：指数价 = 外部喂价，标记价 = 成交 TWAP（无 TWAP 时退回指数价，溢价为 0）。
   * 两者同源时溢价天然为 0，不会凭空产生资金费。
   */
  async getFundingInputs() {
    const indexPrice = await this.getIndexPrice();
    const twap = this.twap.getMark(Date.now());
    if (twap !== null) return { markPrice: twap, indexPrice, markSource: "trade-twap" };
    if (indexPrice !== null) return { markPrice: indexPrice, indexPrice, markSource: "external-feed" };
    const latest = this.twap.latest();
    if (latest !== null) return { markPrice: latest, indexPrice, markSource: "last-trade" };
    return null;
  }
}
