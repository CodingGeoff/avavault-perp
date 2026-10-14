import { describe, expect, it } from "vitest";
import { TwapMarkPrice } from "../src/markPrice.js";

const T0 = 1_000_000;

describe("TwapMarkPrice", () => {
  it("样本不足时不假装有 TWAP", () => {
    const twap = new TwapMarkPrice({ windowMs: 60_000 });
    expect(twap.getMark(T0)).toBeNull();
    twap.addSample(2500n, T0);
    expect(twap.getMark(T0 + 10_000)).toBeNull();
    expect(twap.getMarkOrLatest(T0 + 10_000)).toBe(2500n); // 退回最新价
  });

  it("等权重时段的价格取平均", () => {
    const twap = new TwapMarkPrice({ windowMs: 60_000 });
    twap.addSample(2000n, T0);
    twap.addSample(3000n, T0 + 30_000);
    // 2000 持续 30s、3000 持续 30s -> 2500
    expect(twap.getMark(T0 + 60_000)).toBe(2500n);
  });

  it("一笔瞬时砸盘几乎拉不动 TWAP（抗标记价猎杀的核心性质）", () => {
    const twap = new TwapMarkPrice({ windowMs: 60_000 });
    twap.addSample(2500n, T0);
    twap.addSample(2500n, T0 + 30_000);
    twap.addSample(1000n, T0 + 59_000); // 窗口末尾 1 秒的砸盘价
    const mark = twap.getMark(T0 + 60_000)!;
    expect(mark).toBeGreaterThan(2400n); // 离 2500 很近，完全没被 1000 带走
  });

  it("持续的价格移动最终会反映到 TWAP", () => {
    const twap = new TwapMarkPrice({ windowMs: 60_000 });
    twap.addSample(2500n, T0);
    twap.addSample(2000n, T0 + 5_000);
    twap.addSample(2000n, T0 + 55_000);
    expect(twap.getMark(T0 + 60_000)).toBeLessThan(2100n);
  });

  it("乱序与非正价格样本被拒绝", () => {
    const twap = new TwapMarkPrice({ windowMs: 60_000 });
    twap.addSample(2500n, T0 + 10_000);
    twap.addSample(1000n, T0); // 时间更早，乱序
    twap.addSample(0n, T0 + 20_000);
    expect(twap.latest()).toBe(2500n);
  });
});

describe("TwapMarkPrice — 新鲜度", () => {
  it("latestTimestamp 返回最新样本时间，无样本为 null", () => {
    const twap = new TwapMarkPrice({ windowMs: 60_000 });
    expect(twap.latestTimestamp()).toBeNull();
    twap.addSample(2500n, T0);
    twap.addSample(2600n, T0 + 5_000);
    expect(twap.latestTimestamp()).toBe(T0 + 5_000);
  });
});
