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
 * - 标记价格由调用方注入（独立预言机给出的价格）；没有标记价时用入场价，未实现盈亏为 0。
 * - 资金费率按标记价相对指数价的溢价计算（调用方传入指数价）：标记价高于指数价时
 *   费率为正、多头付空头，反之空头付多头；费率绝对值封顶，结算直接调整各仓位的
 *   已分配保证金，并累计到 cumulativeFunding 供审计/展示。没有独立指数价时调用方
 *   不应结算资金费（费率视为 0），避免拿标记价和它自己比出假溢价。
 */

export interface Position {
  traderId: string;
  sizeSigned: bigint;
  entryPrice: bigint;
  marginAllocated: bigint;
  /** 最近一次开仓使用的杠杆（展示用；实际占用按每次加仓的名义/杠杆逐笔累积） */
  leverage: number;
  realizedPnl: bigint;
  /** 累计已结算资金费现金流：正数=净收到，负数=净支付 */
  cumulativeFunding: bigint;
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
  /** 穿仓缺口中由保险基金实际兜底的部分 */
  insuranceCovered: bigint;
  /** 保险基金也不足时的剩余坏账 */
  badDebt: bigint;
  /** 本次强平罚金（计入保险基金） */
  penalty: bigint;
}

export interface FundingPayment {
  traderId: string;
  sizeSigned: bigint;
  /** 本期费率（bps，正数表示多头付空头） */
  rateBps: number;
  /** 带符号现金流：正数=该仓位收到资金费，负数=支付资金费 */
  cashflow: bigint;
  marginAllocated: bigint;
  cumulativeFunding: bigint;
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
  readonly liquidationPenaltyBps: bigint;
  /** 保险基金余额：来源是强平罚金与外部注资，专门兜底强平穿仓缺口 */
  insuranceFund = 0n;
  /** 历史上由保险基金实际兜底的累计金额 */
  totalInsuranceCovered = 0n;
  /** 保险基金也不够兜底时留下的累计坏账（需要协议收入/后续注资偿还） */
  totalBadDebt = 0n;

  constructor(opts: { maintenanceMarginBps?: number; maxLeverage?: number; liquidationPenaltyBps?: number } = {}) {
    this.maintenanceMarginBps = BigInt(opts.maintenanceMarginBps ?? 500); // 默认 5%
    this.maxLeverage = opts.maxLeverage ?? 20;
    this.liquidationPenaltyBps = BigInt(opts.liquidationPenaltyBps ?? 50); // 默认名义价值的 0.5%
  }

  /** 清空全部仓位/标记价/保险基金状态（演示彩排后重置用；调用方负责同步清库） */
  reset(): void {
    this.positions.clear();
    this.markPrice = null;
    this.insuranceFund = 0n;
    this.totalInsuranceCovered = 0n;
    this.totalBadDebt = 0n;
  }

  /** 向保险基金注资（运营方/协议收入注入，金额为保证金代币最小单位） */
  fundInsurance(amount: bigint): void {
    if (amount <= 0n) throw new Error("insurance funding amount must be > 0");
    this.insuranceFund += amount;
  }

  getInsuranceState() {
    return {
      insuranceFund: this.insuranceFund,
      totalInsuranceCovered: this.totalInsuranceCovered,
      totalBadDebt: this.totalBadDebt,
    };
  }

  restoreInsuranceState(state: { insuranceFund: bigint; totalInsuranceCovered: bigint; totalBadDebt: bigint }): void {
    this.insuranceFund = state.insuranceFund;
    this.totalInsuranceCovered = state.totalInsuranceCovered;
    this.totalBadDebt = state.totalBadDebt;
  }

  setMarkPrice(price: bigint): void {
    if (price > 0n) this.markPrice = price;
  }

  getMarkPrice(): bigint | null {
    return this.markPrice;
  }

  private empty(traderId: string): Position {
    return { traderId, sizeSigned: 0n, entryPrice: 0n, marginAllocated: 0n, leverage: 1, realizedPnl: 0n, cumulativeFunding: 0n };
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

  /** 以当前标记价强平：结算盈亏、罚金计入保险基金、穿仓缺口由保险基金兜底 */
  liquidate(traderId: string): LiquidationRecord | null {
    const snap = this.snapshot(traderId);
    if (snap.sizeSigned === 0n) return null;
    const pos = this.getPosition(traderId);
    const absSize = snap.sizeSigned > 0n ? snap.sizeSigned : -snap.sizeSigned;
    const notionalAtMark = absSize * snap.markPrice;

    let returnedMargin = 0n;
    let penalty = 0n;
    let deficit = 0n;
    let insuranceCovered = 0n;
    let badDebt = 0n;

    if (snap.equity > 0n) {
      // 还有剩余权益：按名义价值收强平罚金（封顶为剩余权益），其余退回
      penalty = (notionalAtMark * this.liquidationPenaltyBps) / BPS_DENOMINATOR;
      if (penalty > snap.equity) penalty = snap.equity;
      returnedMargin = snap.equity - penalty;
      this.insuranceFund += penalty;
    } else if (snap.equity < 0n) {
      // 穿仓：缺口先由保险基金兜底，不够的部分记坏账，绝不向用户追偿到负余额
      deficit = -snap.equity;
      insuranceCovered = deficit < this.insuranceFund ? deficit : this.insuranceFund;
      this.insuranceFund -= insuranceCovered;
      this.totalInsuranceCovered += insuranceCovered;
      badDebt = deficit - insuranceCovered;
      this.totalBadDebt += badDebt;
    }

    const record: LiquidationRecord = {
      traderId,
      sizeSigned: snap.sizeSigned,
      entryPrice: snap.entryPrice,
      liquidationPrice: snap.markPrice,
      pnl: snap.unrealizedPnl,
      returnedMargin,
      deficit,
      insuranceCovered,
      badDebt,
      penalty,
    };
    pos.realizedPnl += snap.unrealizedPnl;
    pos.sizeSigned = 0n;
    pos.entryPrice = 0n;
    pos.marginAllocated = 0n;
    return record;
  }

  /** 当前多空未平仓名义价值（按各仓位快照使用的标记价计） */
  getOpenInterest() {
    let longNotional = 0n;
    let shortNotional = 0n;
    for (const snap of this.allSnapshots()) {
      const notional = (snap.sizeSigned > 0n ? snap.sizeSigned : -snap.sizeSigned) * snap.markPrice;
      if (snap.sizeSigned > 0n) longNotional += notional;
      else shortNotional += notional;
    }
    return { longNotional, shortNotional };
  }

  /**
   * 由标记价相对指数价的溢价推导资金费率（bps/期）：
   * premiumBps = (mark - index) / index × 10000，费率 = premiumBps 并封顶到 ±maxAbsBps。
   * 标记价高于指数价（多头拥挤）时为正：多头付空头；低于时为负。指数价缺失/非正返回 0。
   */
  static calculateFundingRateBps(markPrice: bigint, indexPrice: bigint | null, maxAbsBps = 10): number {
    if (!Number.isInteger(maxAbsBps) || maxAbsBps < 0) {
      throw new Error("maxAbsBps must be a non-negative integer");
    }
    if (indexPrice === null || indexPrice <= 0n || markPrice <= 0n || maxAbsBps === 0) return 0;
    const premiumBps = Number(((markPrice - indexPrice) * 10_000n) / indexPrice);
    return Math.max(-maxAbsBps, Math.min(maxAbsBps, premiumBps));
  }

  /**
   * 按给定费率结算一期资金费：直接调整每个未平仓位的 marginAllocated，
   * cashflow 累计进 cumulativeFunding。rate > 0 时多头付、空头收；rate < 0 相反。
   * 返回逐仓位现金流记录（零仓位不参与）。
   */
  applyFunding(rateBps: number): FundingPayment[] {
    if (!Number.isInteger(rateBps)) throw new Error("funding rateBps must be an integer");
    const payments: FundingPayment[] = [];
    if (rateBps === 0) return payments;
    for (const pos of this.positions.values()) {
      if (pos.sizeSigned === 0n) continue;
      const snap = this.snapshot(pos.traderId);
      const absSize = pos.sizeSigned > 0n ? pos.sizeSigned : -pos.sizeSigned;
      const amount = (absSize * snap.markPrice * BigInt(Math.abs(rateBps))) / BPS_DENOMINATOR;
      if (amount === 0n) continue;
      const isPayer = rateBps > 0 ? pos.sizeSigned > 0n : pos.sizeSigned < 0n;
      const cashflow = isPayer ? -amount : amount;
      pos.marginAllocated += cashflow;
      pos.cumulativeFunding += cashflow;
      payments.push({
        traderId: pos.traderId,
        sizeSigned: pos.sizeSigned,
        rateBps,
        cashflow,
        marginAllocated: pos.marginAllocated,
        cumulativeFunding: pos.cumulativeFunding,
      });
    }
    return payments;
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
      cumulativeFunding: pos.cumulativeFunding.toString(),
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
      cumulativeFunding: BigInt(data.cumulativeFunding ?? "0"),
    });
  }
}
