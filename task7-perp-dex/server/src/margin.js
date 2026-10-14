/**
 * 保证金来源聚合：把两个链上金库的余额合成一个"可用保证金"视图。
 *
 * - 任务 7 的 Vault/VaultV2：mUSDC 保证金余额（成交结算实际扣款的地方）。
 * - 黑客松的 MultiCollateralVaultV2：用户存入的 RWA 等抵押品经 TWAP 估值、
 *   打折后的账户总价值 `totalAccountValue()`，计价单位是登记抵押品时配置的
 *   quote token（当前 Fuji 部署为 WAVAX，18 位小数）。
 *
 * 两个来源单位不同，要合并必须把 quote 计价的 RWA 价值换算成保证金代币
 * （mUSDC，6 位小数）。换算率（quote token 的美元价）由部署方显式配置，
 * 本模块不内置任何写死的价格：未配置换算率时 RWA 价值只展示、不计入
 * 可用保证金，避免用一个编造的汇率假装精确。
 */

const QUOTE_DECIMALS_FACTOR = 10n ** 18n; // totalAccountValue 返回 18 位小数值

/** 把 "35.25" 这类十进制字符串解析成放大 1e6 的 BigInt，避免浮点误差进保证金计算 */
export function parsePriceToE6(text) {
  const s = String(text).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) {
    throw new Error(`invalid price "${text}" (expected a decimal with up to 6 fraction digits)`);
  }
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
}

/**
 * quote 计价价值（18 位）-> 保证金代币数量（6 位）。
 * margin = quoteValue / 1e18 * priceUsd * 1e6 = quoteValue * priceE6 / 1e18
 */
export function convertQuoteValueToMargin(quoteValue18, quotePriceE6) {
  return (BigInt(quoteValue18) * BigInt(quotePriceE6)) / QUOTE_DECIMALS_FACTOR;
}

export class MarginService {
  /**
   * @param {object} opts
   * @param {null|((address:string)=>Promise<bigint>)} opts.readVaultBalance 读 Vault 的 mUSDC 余额
   * @param {null|((address:string)=>Promise<bigint>)} opts.readRwaAccountValue 读 MultiCollateralVaultV2.totalAccountValue
   * @param {bigint|null} opts.quotePriceE6 quote token 美元价（放大 1e6）；null 表示不把 RWA 价值计入可用保证金
   * @param {number} [opts.cacheTtlMs] 链上读数缓存毫秒数，避免每笔下单都打 RPC
   */
  constructor({ readVaultBalance = null, readRwaAccountValue = null, quotePriceE6 = null, cacheTtlMs = 15_000 }) {
    this.readVaultBalance = readVaultBalance;
    this.readRwaAccountValue = readRwaAccountValue;
    this.quotePriceE6 = quotePriceE6;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = new Map(); // address(lowercase) -> { at, value }
  }

  get rwaConfigured() {
    return !!this.readRwaAccountValue;
  }

  /** RWA 价值是否真的计入了可用保证金（配置了读取器且配置了换算率） */
  get rwaCounted() {
    return this.rwaConfigured && this.quotePriceE6 !== null;
  }

  async getMargin(address) {
    const key = String(address).toLowerCase();
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cacheTtlMs) return hit.value;

    const sourceErrors = [];
    let vaultBalance = 0n;
    let rwaAccountValueQuote = 0n;

    if (this.readVaultBalance) {
      try {
        vaultBalance = BigInt(await this.readVaultBalance(address));
      } catch (e) {
        sourceErrors.push(`vault balance unavailable: ${e.message}`);
      }
    }
    if (this.readRwaAccountValue) {
      try {
        rwaAccountValueQuote = BigInt(await this.readRwaAccountValue(address));
      } catch (e) {
        sourceErrors.push(`RWA collateral value unavailable: ${e.message}`);
      }
    }

    const rwaMarginValue = this.quotePriceE6 === null
      ? null
      : convertQuoteValueToMargin(rwaAccountValueQuote, this.quotePriceE6);

    const value = {
      address,
      vaultBalance,
      rwaAccountValueQuote,
      rwaMarginValue,
      // 未配置换算率时 RWA 不计入（rwaMarginValue 只作展示），配置了才真正叠加
      effectiveMargin: vaultBalance + (rwaMarginValue ?? 0n),
      rwaConfigured: this.rwaConfigured,
      rwaCounted: this.rwaCounted,
      sourceErrors,
    };
    // 有读取失败的结果不缓存，避免把一次 RPC 抖动放大成整个缓存窗口的错误判断
    if (sourceErrors.length === 0) this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** 买方保证金是否覆盖本次所需金额（结算时买方是付款方） */
  async checkSufficient(address, requiredAmount) {
    const margin = await this.getMargin(address);
    return { ...margin, requiredAmount: BigInt(requiredAmount), sufficient: margin.effectiveMargin >= BigInt(requiredAmount) };
  }

  invalidate(address) {
    if (address) this.cache.delete(String(address).toLowerCase());
    else this.cache.clear();
  }
}
