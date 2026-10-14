/**
 * 永续仓位引擎：把订单簿成交转换成带杠杆的净仓位，并负责保证金占用、
 * 未实现盈亏与强平判定。它只做记账与风控，不碰资金——资金托管与结算
 * 仍在链上 Vault 里，这里的保证金数字必须由调用方用真实保证金来源
 * （Vault 余额 + RWA 抵押估值）在下单前校验、并持续对照。
 *
 * 模型（刻意保持最小但完整）：
 * - 每个交易者一个净仓位：sizeSigned > 0 多头，< 0 空头。
 * - 开仓/加仓按数量加权平均入场价（VWAP）；平仓/减仓按比例释放保证金
 *   并结算已实现盈亏；反手时先平后开。
 * - 初始保证金 = 加仓名义价值 / 杠杆；维持保证金 = 当前标记价名义价值 ×
 *   maintenanceMarginBps。权益 = 已分配保证金 + 未实现盈亏，
 *   权益 < 维持保证金即触发强平（以标记价平仓，多余保证金退回，
 *   权益为负的部分记为穿仓缺口 deficit，等待保险基金/结算层处理）。
 * - 标记价格由调用方注入（最新成交价）；没有标记价时用入场价，未实现盈亏为 0。
 */

export interface Position {
  traderId: string;
  sizeSigned: bigint;
  entryPrice: bigint;
  marginAllocated: bigint;
  /** 最近一次开仓使用的杠杆（展示用；实际占用按每次加仓的名义/杠杆逐笔累积） */
  leverage: number;
  realizedPnl: bigint;
}

export interface PositionSnapshot extends Position {
  markPrice: bigint;
  unrealizedPnl: bigint;
  equity: bigint;
  maintenanceMargin: bigint;
  liquidationPrice: bigint | null;
  liquidatable: boolean;
}

export interface LiquidationRecord {
  traderId: string;
  sizeSigned: bigint;
  entryPrice: bigint;
  liquidationPrice: bigint;
  pnl: bigint;
  returnedMargin: bigint;
  deficit: bigint;
}

const BPS_DENOMINATOR = 10_000n;

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

export class PositionManager {
  private positions = new Map<string, Position>();
  private markPrice: bigint | null = null;
  readonly maintenanceMarginBps: bigint;
  readonly maxLeverage: number;

  constructor(opts: { maintenanceMarginBps?: number; maxLeverage?: number } = {}) {
    this.maintenanceMarginBps = BigInt(opts.maintenanceMarginBps ?? 500); // 默认 5%
    this.maxLeverage = opts.maxLeverage ?? 20;
  }

  setMarkPrice(price: bigint): void {
    if (price > 0n) this.markPrice = price;
  }

  getMarkPrice(): bigint | null {
    return this.markPrice;
  }

  private empty(traderId: string): Position {
    return { traderId, sizeSigned: 0n, entryPrice: 0n, marginAllocated: 0n, leverage: 1, realizedPnl: 0n };
  }

  getPosition(traderId: string): Position {
    return this.positions.get(traderId) ?? this.empty(traderId);
  }

  /** 已被未平仓位占用的保证金（调用方做"可用保证金"校验时要先扣掉这部分） */
  reservedMargin(traderId: string): bigint {
    return this.getPosition(traderId).marginAllocated;
  }

  private applyDelta(pos: Position, deltaQty: bigint, price: bigint, leverage: number): void {
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > this.maxLeverage) {
      throw new Error(`leverage must be an integer in [1, ${this.maxLeverage}]`);
    }
    if (deltaQty === 0n) return;

    const sameDirection =
      pos.sizeSigned === 0n || (pos.sizeSigned > 0n) === (deltaQty > 0n);

    if (sameDirection) {
      const addQty = deltaQty > 0n ? deltaQty : -deltaQty;
      const openQty = pos.sizeSigned > 0n ? pos.sizeSigned : -pos.sizeSigned;
      pos.entryPrice =
        openQty === 0n ? price : (openQty * pos.entryPrice + addQty * price) / (openQty + addQty);
      pos.marginAllocated += ceilDiv(addQty * price, BigInt(leverage));
      pos.leverage = leverage;
      pos.sizeSigned += deltaQty;
      return;
    }

    // 反方向：先平仓（结算已实现盈亏、按比例释放保证金），剩余量反手开仓
    let remaining = deltaQty > 0n ? deltaQty : -deltaQty;
    const openQty = pos.sizeSigned > 0n ? pos.sizeSigned : -pos.sizeSigned;
    const closeQty = remaining < openQty ? remaining : openQty;
    const isLong = pos.sizeSigned > 0n;
    pos.realizedPnl += isLong
      ? (price - pos.entryPrice) * closeQty
      : (pos.entryPrice - price) * closeQty;
    pos.marginAllocated -= (pos.marginAllocated * closeQty) / openQty;
    pos.sizeSigned += isLong ? -closeQty : closeQty;
    remaining -= closeQty;

    if (pos.sizeSigned === 0n) {
      pos.marginAllocated = 0n;
      pos.entryPrice = 0n;
    }
    if (remaining > 0n) {
      const signed = deltaQty > 0n ? remaining : -remaining;
      this.applyDelta(pos, signed, price, leverage);
    }
  }

  /**
   * 把一笔成交记到买卖双方头上：买方仓位 +quantity，卖方 -quantity。
   * 返回双方记账后的仓位快照。
   */
  applyTrade(trade: {
    buyTraderId: string;
    sellTraderId: string;
    price: bigint;
    quantity: bigint;
    buyLeverage?: number;
    sellLeverage?: number;
  }): { buyer: PositionSnapshot; seller: PositionSnapshot } {
    const buyer = this.getPosition(trade.buyTraderId);
    const seller = this.getPosition(trade.sellTraderId);
    this.positions.set(trade.buyTraderId, buyer);
    this.positions.set(trade.sellTraderId, seller);
    this.applyDelta(buyer, trade.quantity, trade.price, trade.buyLeverage ?? 1);
    this.applyDelta(seller, -trade.quantity, trade.price, trade.sellLeverage ?? 1);
    this.setMarkPrice(trade.price);
    return { buyer: this.snapshot(trade.buyTraderId), seller: this.snapshot(trade.sellTraderId) };
  }

  snapshot(traderId: string): PositionSnapshot {
    const pos = this.getPosition(traderId);
    const mark = this.markPrice ?? pos.entryPrice;
    const absSize = pos.sizeSigned > 0n ? pos.sizeSigned : -pos.sizeSigned;
    let unrealizedPnl = 0n;
    if (pos.sizeSigned > 0n) unrealizedPnl = (mark - pos.entryPrice) * absSize;
    if (pos.sizeSigned < 0n) unrealizedPnl = (pos.entryPrice - mark) * absSize;
    const maintenanceMargin =
      pos.sizeSigned === 0n ? 0n : ceilDiv(absSize * mark * this.maintenanceMarginBps, BPS_DENOMINATOR);
    const equity = pos.marginAllocated + unrealizedPnl;
    return {
      ...pos,
      markPrice: mark,
      unrealizedPnl,
      equity,
      maintenanceMargin,
      liquidationPrice: this.liquidationPrice(pos),
      liquidatable: pos.sizeSigned !== 0n && equity < maintenanceMargin,
    };
  }

  /** 权益恰好等于维持保证金时的标记价；仓位为空返回 null */
  liquidationPrice(pos: Position): bigint | null {
    if (pos.sizeSigned === 0n) return null;
    const q = pos.sizeSigned > 0n ? pos.sizeSigned : -pos.sizeSigned;
    const bps = this.maintenanceMarginBps;
    if (pos.sizeSigned > 0n) {
      // margin + (p - entry) * q = q * p * bps / 10000
      const numerator = (pos.entryPrice * q - pos.marginAllocated) * BPS_DENOMINATOR;
      if (numerator <= 0n) return 0n;
      return numerator / (q * (BPS_DENOMINATOR - bps));
    }
    // margin + (entry - p) * q = q * p * bps / 10000
    return ((pos.entryPrice * q + pos.marginAllocated) * BPS_DENOMINATOR) / (q * (BPS_DENOMINATOR + bps));
  }

  /** 扫描全部仓位，返回当前可强平的快照（不执行） */
  checkLiquidations(): PositionSnapshot[] {
    return [...this.positions.keys()].map((id) => this.snapshot(id)).filter((s) => s.liquidatable);
  }

  /** 以当前标记价强平：结算盈亏、退回多余保证金、记录穿仓缺口，并清空仓位 */
  liquidate(traderId: string): LiquidationRecord | null {
    const snap = this.snapshot(traderId);
    if (snap.sizeSigned === 0n) return null;
    const pos = this.getPosition(traderId);
    const record: LiquidationRecord = {
      traderId,
      sizeSigned: snap.sizeSigned,
      entryPrice: snap.entryPrice,
      liquidationPrice: snap.markPrice,
      pnl: snap.unrealizedPnl,
      returnedMargin: snap.equity > 0n ? snap.equity : 0n,
      deficit: snap.equity < 0n ? -snap.equity : 0n,
    };
    pos.realizedPnl += snap.unrealizedPnl;
    pos.sizeSigned = 0n;
    pos.entryPrice = 0n;
    pos.marginAllocated = 0n;
    return record;
  }

  /** 全部未平仓位快照 */
  allSnapshots(): PositionSnapshot[] {
    return [...this.positions.keys()]
      .map((id) => this.snapshot(id))
      .filter((s) => s.sizeSigned !== 0n);
  }

  /** 序列化单个仓位（持久化用，BigInt 转字符串） */
  static serialize(pos: Position) {
    return {
      traderId: pos.traderId,
      sizeSigned: pos.sizeSigned.toString(),
      entryPrice: pos.entryPrice.toString(),
      marginAllocated: pos.marginAllocated.toString(),
      leverage: pos.leverage,
      realizedPnl: pos.realizedPnl.toString(),
    };
  }

  restore(data: ReturnType<typeof PositionManager.serialize>): void {
    this.positions.set(data.traderId, {
      traderId: data.traderId,
      sizeSigned: BigInt(data.sizeSigned),
      entryPrice: BigInt(data.entryPrice),
      marginAllocated: BigInt(data.marginAllocated),
      leverage: data.leverage,
      realizedPnl: BigInt(data.realizedPnl),
    });
  }
}
