/**
 * 对冲仓位测算（纯函数）：把"持有一份生息 RWA、想用永续对其价格风险对冲"
 * 这个场景落成可计算的规则，而不是让用户自己随手填数量。
 *
 * 规则：
 * - 对冲名义价值 = 资产估值 × 对冲比例（bps）。全额对冲 10000、半对冲 5000。
 * - 建议数量 = 名义价值 / 参考价，向下取整（宁可少对冲一点，也不超额开仓）。
 * - 所需保证金 = 名义价值 / 杠杆，向上取整（与 positions.ts 的占用规则一致）。
 * - 覆盖判断：所需保证金 <= 可用保证金才算"保证金足够支撑这一单对冲"；
 *   本函数只测算、不下单，保证金不足时把缺口如实返回，由调用方决定是否拦截。
 */
export interface HedgeQuote {
  /** 对冲名义价值（保证金代币最小单位口径，与价格单位相乘后同量纲） */
  notional: bigint;
  /** 建议下单数量（按参考价向下取整） */
  quantity: bigint;
  /** 按所选杠杆占用的保证金 */
  requiredMargin: bigint;
  /** 可用保证金（入参原样回显，便于前端展示覆盖率） */
  availableMargin: bigint;
  /** 可用保证金是否覆盖所需保证金 */
  covered: boolean;
  /** 未覆盖时的保证金缺口（已覆盖时为 0） */
  shortfall: bigint;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

export function computeHedgeQuote(input: {
  assetValue: bigint;
  hedgeRatioBps: number;
  referencePrice: bigint;
  leverage: number;
  availableMargin: bigint;
}): HedgeQuote {
  const { assetValue, hedgeRatioBps, referencePrice, leverage, availableMargin } = input;
  if (assetValue <= 0n) throw new Error("assetValue must be > 0");
  if (!Number.isInteger(hedgeRatioBps) || hedgeRatioBps <= 0 || hedgeRatioBps > 10_000) {
    throw new Error("hedgeRatioBps must be an integer in (0, 10000]");
  }
  if (referencePrice <= 0n) throw new Error("referencePrice must be > 0");
  if (!Number.isInteger(leverage) || leverage < 1) throw new Error("leverage must be a positive integer");
  if (availableMargin < 0n) throw new Error("availableMargin must be >= 0");

  const notional = (assetValue * BigInt(hedgeRatioBps)) / 10_000n;
  const quantity = notional / referencePrice;
  const requiredMargin = ceilDiv(notional, BigInt(leverage));
  const covered = requiredMargin <= availableMargin;
  return {
    notional,
    quantity,
    requiredMargin,
    availableMargin,
    covered,
    shortfall: covered ? 0n : requiredMargin - availableMargin,
  };
}
