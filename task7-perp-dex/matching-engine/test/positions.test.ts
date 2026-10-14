import { describe, expect, it } from "vitest";
import { PositionManager } from "../src/positions.js";

const ALICE = "0xAlice";
const BOB = "0xBob";

describe("PositionManager — 开仓与保证金占用", () => {
  it("买方开多、卖方开空，入场价与保证金按杠杆计算", () => {
    const pm = new PositionManager();
    const { buyer, seller } = pm.applyTrade({
      buyTraderId: ALICE, sellTraderId: BOB, price: 2500n, quantity: 10n,
      buyLeverage: 5, sellLeverage: 2,
    });
    expect(buyer.sizeSigned).toBe(10n);
    expect(buyer.entryPrice).toBe(2500n);
    expect(buyer.marginAllocated).toBe(5000n); // 25000 / 5
    expect(seller.sizeSigned).toBe(-10n);
    expect(seller.marginAllocated).toBe(12500n); // 25000 / 2
  });

  it("加仓按 VWAP 更新入场价并累积保证金", () => {
    const pm = new PositionManager();
    pm.applyTrade({ buyTraderId: ALICE, sellTraderId: BOB, price: 2000n, quantity: 10n });
    const { buyer } = pm.applyTrade({ buyTraderId: ALICE, sellTraderId: BOB, price: 3000n, quantity: 10n });
    expect(buyer.sizeSigned).toBe(20n);
    expect(buyer.entryPrice).toBe(2500n);
    expect(buyer.marginAllocated).toBe(20000n + 30000n);
  });

  it("杠杆越界被拒绝", () => {
    const pm = new PositionManager();
    expect(() =>
      pm.applyTrade({ buyTraderId: ALICE, sellTraderId: BOB, price: 100n, quantity: 1n, buyLeverage: 21 })
    ).toThrow(/leverage/);
    expect(() =>
      pm.applyTrade({ buyTraderId: ALICE, sellTraderId: BOB, price: 100n, quantity: 1n, buyLeverage: 0 })
    ).toThrow(/leverage/);
  });
});

describe("PositionManager — 平仓、反手与已实现盈亏", () => {
  it("多头涨价后平仓实现盈利，并按比例释放保证金", () => {
    const pm = new PositionManager();
    pm.applyTrade({ buyTraderId: ALICE, sellTraderId: BOB, price: 2500n, quantity: 10n });
    const { seller: aliceClosing } = pm.applyTrade({
      buyTraderId: BOB, sellTraderId: ALICE, price: 3000n, quantity: 4n,
    });
    expect(aliceClosing.sizeSigned).toBe(6n);
    expect(aliceClosing.realizedPnl).toBe(500n * 4n);
    expect(aliceClosing.marginAllocated).toBe(25000n - 10000n);
  });

  it("平仓后反手：先结算旧仓盈亏，再以新价开反向仓", () => {
    const pm = new PositionManager();
    pm.applyTrade({ buyTraderId: ALICE, sellTraderId: BOB, price: 2500n, quantity: 10n });
    const { seller } = pm.applyTrade({ buyTraderId: BOB, sellTraderId: ALICE, price: 2000n, quantity: 15n });
    // 原多头 10 全部平掉（亏 500*10），剩余 5 开空
    expect(seller.sizeSigned).toBe(-5n);
    expect(seller.entryPrice).toBe(2000n);
    expect(seller.realizedPnl).toBe(-5000n);
    expect(seller.marginAllocated).toBe(5n * 2000n);
  });
});

describe("PositionManager — 盈亏、维持保证金与强平", () => {
  it("未实现盈亏随标记价变化", () => {
    const pm = new PositionManager();
    pm.applyTrade({ buyTraderId: ALICE, sellTraderId: BOB, price: 2500n, quantity: 10n });
    pm.setMarkPrice(2000n);
    const long = pm.snapshot(ALICE);
    expect(long.unrealizedPnl).toBe(-5000n);
    expect(pm.snapshot(BOB).unrealizedPnl).toBe(5000n); // 空头对称盈利
  });

  it("杠杆越高强平价离入场价越近", () => {
    const pm1 = new PositionManager();
    pm1.applyTrade({ buyTraderId: ALICE, sellTraderId: BOB, price: 2500n, quantity: 10n, buyLeverage: 1 });
    const pm10 = new PositionManager();
    pm10.applyTrade({ buyTraderId: ALICE, sellTraderId: BOB, price: 2500n, quantity: 10n, buyLeverage: 10 });
    const low = pm1.snapshot(ALICE).liquidationPrice!;
    const high = pm10.snapshot(ALICE).liquidationPrice!;
    // 多头强平价都在入场价下方，10x 的明显更高（更接近入场价）
    expect(low).toBeLessThan(2500n);
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThan(2500n);
  });

  it("权益跌破维持保证金后可被强平，缺口被单独记录", () => {
    const pm = new PositionManager({ maintenanceMarginBps: 500 });
    // 10x 开多：保证金 2500，随后价格从 2500 跌到 2200（亏 3000 > 保证金）
    pm.applyTrade({ buyTraderId: ALICE, sellTraderId: BOB, price: 2500n, quantity: 10n, buyLeverage: 10 });
    pm.setMarkPrice(2200n);
    const atRisk = pm.checkLiquidations().map((s) => s.traderId);
    expect(atRisk).toContain(ALICE);
    const record = pm.liquidate(ALICE)!;
    expect(record.pnl).toBe(-3000n);
    expect(record.returnedMargin).toBe(0n);
    expect(record.deficit).toBe(500n); // 2500 保证金亏完后还差 500
    expect(pm.snapshot(ALICE).sizeSigned).toBe(0n);
  });

  it("小跌幅不触发强平（保证金充足时）", () => {
    const pm = new PositionManager({ maintenanceMarginBps: 500 });
    pm.applyTrade({ buyTraderId: ALICE, sellTraderId: BOB, price: 2500n, quantity: 10n, buyLeverage: 2 });
    pm.setMarkPrice(2400n); // 亏 1000，保证金 12500，权益远高于维持保证金
    expect(pm.checkLiquidations()).toHaveLength(0);
  });
});

describe("PositionManager — 序列化恢复", () => {
  it("restore 能重建仓位状态", () => {
    const pm = new PositionManager();
    const { buyer } = pm.applyTrade({
      buyTraderId: ALICE, sellTraderId: BOB, price: 2500n, quantity: 10n, buyLeverage: 5,
    });
    const data = PositionManager.serialize(buyer);
    const pm2 = new PositionManager();
    pm2.restore(data);
    const restored = pm2.getPosition(ALICE);
    expect(restored.sizeSigned).toBe(10n);
    expect(restored.marginAllocated).toBe(5000n);
    expect(restored.leverage).toBe(5);
  });
});
