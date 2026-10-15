import { describe, expect, it } from "vitest";
import { computeHedgeQuote } from "../src/hedge.js";

describe("对冲测算 computeHedgeQuote", () => {
  it("全额对冲：名义=资产估值，数量按参考价向下取整，保证金=名义/杠杆", () => {
    const q = computeHedgeQuote({
      assetValue: 1_000_000n, hedgeRatioBps: 10_000, referencePrice: 2500n, leverage: 5, availableMargin: 1_000_000n,
    });
    expect(q.notional).toBe(1_000_000n);
    expect(q.quantity).toBe(400n);
    expect(q.requiredMargin).toBe(200_000n);
    expect(q.covered).toBe(true);
    expect(q.shortfall).toBe(0n);
  });

  it("半对冲只覆盖一半名义；保证金不足时如实给出缺口", () => {
    const q = computeHedgeQuote({
      assetValue: 1_000_000n, hedgeRatioBps: 5_000, referencePrice: 2500n, leverage: 5, availableMargin: 50_000n,
    });
    expect(q.notional).toBe(500_000n);
    expect(q.requiredMargin).toBe(100_000n);
    expect(q.covered).toBe(false);
    expect(q.shortfall).toBe(50_000n);
  });

  it("非法输入抛错（比例越界/价格非正/杠杆非法）", () => {
    const base = { assetValue: 1n, hedgeRatioBps: 5_000, referencePrice: 2500n, leverage: 5, availableMargin: 0n };
    expect(() => computeHedgeQuote({ ...base, hedgeRatioBps: 0 })).toThrow();
    expect(() => computeHedgeQuote({ ...base, hedgeRatioBps: 10_001 })).toThrow();
    expect(() => computeHedgeQuote({ ...base, referencePrice: 0n })).toThrow();
    expect(() => computeHedgeQuote({ ...base, leverage: 0 })).toThrow();
  });
});
