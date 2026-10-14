/**
 * 独立标记价预言机：不直接用最新成交价做标记价（薄市场里一笔小成交就能
 * 把标记价砸到强平线、"猎杀"高杠杆仓位），而是对最近一段时间窗口内的
 * 成交价做时间加权平均（TWAP）。单个瞬时价格要在窗口内持续成交才能
 * 显著移动 TWAP，与金库抵押估值用 TWAP 防操纵是同一思路。
 *
 * 数据源优先级由调用方组合：外部喂价（如有） > 本预言机的成交 TWAP >
 * 最新成交价（样本不足时的兜底）。本类只负责 TWAP 这一层，纯函数式记账，
 * 时间戳由调用方传入，便于测试。
 */

export interface PriceSample {
  price: bigint;
  /** 毫秒时间戳 */
  timestamp: number;
}

export class TwapMarkPrice {
  private samples: PriceSample[] = [];
  readonly windowMs: number;

  constructor(opts: { windowMs?: number } = {}) {
    this.windowMs = opts.windowMs ?? 5 * 60 * 1000; // 默认 5 分钟窗口
  }

  addSample(price: bigint, timestamp: number): void {
    if (price <= 0n) return;
    const last = this.samples[this.samples.length - 1];
    if (last && timestamp < last.timestamp) return; // 拒绝乱序样本
    this.samples.push({ price, timestamp });
    this.prune(timestamp);
  }

  private prune(now: number): void {
    // 保留窗口起点之前最后一个样本（它代表窗口起始时刻的价格），其余过期丢弃
    const cutoff = now - this.windowMs;
    let keepFrom = 0;
    for (let i = 0; i < this.samples.length; i++) {
      if (this.samples[i].timestamp <= cutoff) keepFrom = i;
      else break;
    }
    if (keepFrom > 0) this.samples = this.samples.slice(keepFrom);
  }

  /** 最新一个原始成交价（样本不足时兜底用） */
  latest(): bigint | null {
    return this.samples.length ? this.samples[this.samples.length - 1].price : null;
  }

  /** 最新样本的时间戳（毫秒）；无样本时为 null，供调用方判断标记价是否过期 */
  latestTimestamp(): number | null {
    return this.samples.length ? this.samples[this.samples.length - 1].timestamp : null;
  }

  /**
   * 当前窗口的 TWAP；样本少于 2 个、或窗口内没有时间跨度时返回 null，
   * 表示"TWAP 还不可用"，调用方应退回兜底价格而不是假装有均价。
   */
  getMark(now: number): bigint | null {
    this.prune(now);
    if (this.samples.length < 2) return null;
    const windowStart = now - this.windowMs;
    let weightedSum = 0n;
    let totalWeight = 0n;
    for (let i = 0; i < this.samples.length; i++) {
      const start = Math.max(this.samples[i].timestamp, windowStart);
      const end = i + 1 < this.samples.length ? this.samples[i + 1].timestamp : now;
      const weight = end - start;
      if (weight <= 0) continue;
      weightedSum += this.samples[i].price * BigInt(weight);
      totalWeight += BigInt(weight);
    }
    if (totalWeight === 0n) return null;
    return weightedSum / totalWeight;
  }

  /** TWAP 可用则用 TWAP，否则退回最新价，再否则 null */
  getMarkOrLatest(now: number): bigint | null {
    return this.getMark(now) ?? this.latest();
  }
}
