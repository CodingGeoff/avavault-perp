import { ethers } from "ethers";

/**
 * 演示流动性（服务端做市）。
 *
 * 为什么需要它：这套系统的参考价链条是「外部喂价 > 成交 TWAP > 盘口最优价」，
 * 而**刚重置过的演示环境三者全为空**——没有喂价、没有成交、盘口也没有挂单。
 * 后果不是"少一个数字"，而是整条演示主线断掉：
 *   1. /hedge/quote 拿不到参考价 → 对冲测算失败，第 5 步卡死；
 *   2. 盘口没有对手单 → 第 6 步的对冲空单只能挂着，不成交、没有仓位、没有强平价；
 *   3. 没有成交 → 没有链上结算 → 第 7 步拿不出 Snowtrace 凭证。
 *
 * 解决办法：服务端持有一个**演示做市钱包**（DEMO_MAKER_PRIVATE_KEY），
 * 在中间价两侧挂出真实签名的限价单。关键点：
 *   - 买单带真实的 EIP-712 结算授权（v2 模式必需），所以演示者的空单吃进来时
 *     链上结算能真的成功（前提是这个钱包在 VaultV2 里有 mUSDC 余额）；
 *   - 卖单不需要授权，直接挂；
 *   - 每次重新铺盘口前先撤掉自己上一轮的挂单，不会越铺越厚；
 *   - 余额不足时**如实报警**（warnings），不假装结算会成功。
 *
 * 这个模块不直接依赖 express/数据库：所有网络调用都走可注入的 get/post，
 * 因此可以脱离链上和数据库单测（见 server/test-demoready.mjs）。
 */
export class DemoLiquidity {
  /**
   * @param {object} opts
   * @param {ethers.Wallet|null} opts.makerWallet 做市钱包（未配置时为 null，模块整体停用）
   * @param {(path:string)=>Promise<{status:number,body:any}>} [opts.get]
   * @param {(path:string,body:object)=>Promise<{status:number,body:any}>} [opts.post]
   * @param {bigint} [opts.midPrice] 演示中间价（系统价格口径 = 保证金代币最小单位）
   * @param {number} [opts.levels] 每侧档位数
   * @param {bigint} [opts.baseQty] 第一档数量，越远越厚
   * @param {bigint} [opts.tick] 档位间距
   * @param {null|((address:string)=>Promise<bigint>)} [opts.readVaultBalance] 读做市钱包的 Vault 余额
   * @param {(msg:string)=>void} [opts.log]
   */
  constructor({
    makerWallet = null,
    get = null,
    post = null,
    midPrice = 2500n,
    levels = 3,
    baseQty = 100n,
    tick = 1n,
    readVaultBalance = null,
    log = (...args) => console.log(...args),
  }) {
    this.makerWallet = makerWallet;
    this.midPrice = BigInt(midPrice);
    this.levels = levels;
    this.baseQty = BigInt(baseQty);
    this.tick = BigInt(tick);
    this.readVaultBalance = readVaultBalance;
    this.log = log;
    this.domain = null;
    this.openOrderIds = [];
    this.lastSeedAt = null;
    const transport = defaultTransport(get, post);
    this.get = transport.get;
    this.post = transport.post;
  }

  get enabled() {
    return !!this.makerWallet;
  }

  get address() {
    return this.makerWallet ? this.makerWallet.address : null;
  }

  /** 做市钱包必须先有会话，否则 /orders 会 401（服务端自己也不例外） */
  async ensureSession() {
    if (!this.enabled) throw new Error("demo liquidity disabled (DEMO_MAKER_PRIVATE_KEY not set)");
    const address = this.makerWallet.address;
    const message = `Mini-Dex login for ${address} at ${Date.now()}`;
    const signature = await this.makerWallet.signMessage(message);
    const res = await this.post("/auth/login", { address, message, signature });
    if (res.status !== 200) throw new Error(`demo maker login failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
    return address;
  }

  /** v2 结算模式下买单必须带授权；服务端不是 v2 时 /settlement/domain 返回 400，退回不带授权 */
  async loadDomain() {
    try {
      const res = await this.get("/settlement/domain");
      this.domain = res.status === 200 ? res.body : null;
    } catch {
      this.domain = null;
    }
    return this.domain;
  }

  async buildAuthorization(price, quantity) {
    if (!this.domain) return undefined;
    const { domain, types } = this.domain;
    const maxAmount = (BigInt(price) * BigInt(quantity)).toString();
    const nonce = (Date.now() * 1000 + Math.floor(Math.random() * 1000)).toString();
    const deadline = (Math.floor(Date.now() / 1000) + 3600).toString();
    const signature = await this.makerWallet.signTypedData(domain, types, {
      from: this.makerWallet.address,
      maxAmount,
      nonce,
      deadline,
    });
    return { maxAmount, nonce, deadline, signature };
  }

  async cancelOwnOrders() {
    // 先用内存里的 ID，再从服务端订单簿补查一次。服务重启后 this.openOrderIds 会丢，
    // 但 SQLite 恢复的挂单仍在；若只看内存，点第二次“铺盘口”会让旧档位越叠越多。
    const ids = new Set(this.openOrderIds);
    try {
      const res = await this.get("/orders/open");
      if (res.status === 200 && Array.isArray(res.body)) {
        for (const order of res.body) {
          if (String(order.traderId).toLowerCase() === this.makerWallet.address.toLowerCase() && BigInt(order.remaining) > 0n) {
            ids.add(order.id);
          }
        }
      }
    } catch {}
    this.openOrderIds = [];
    for (const id of ids) {
      await this.post(`/orders/${id}/cancel`, { traderId: this.makerWallet.address }).catch(() => {});
    }
    return ids.size;
  }

  /**
   * 铺一轮双边盘口。
   * @returns {Promise<{ok:boolean, maker:string, cancelled:number, placed:number, orders:Array, bestBid:string|null, bestAsk:string|null, makerVaultBalance:string|null, warnings:string[]}>}
   */
  async seed() {
    const warnings = [];
    if (!this.enabled) {
      return {
        ok: false,
        maker: null,
        cancelled: 0,
        placed: 0,
        orders: [],
        bestBid: null,
        bestAsk: null,
        makerVaultBalance: null,
        warnings: ["DEMO_MAKER_PRIVATE_KEY not set — server-side demo liquidity is disabled"],
      };
    }
    await this.ensureSession();
    if (this.domain === null) await this.loadDomain();
    if (this.domain === null) warnings.push("server is not in v2 settlement mode; buy orders are posted without authorization");

    // 做市钱包在 Vault 里没钱的话，成交能撮合但链上结算必然失败（买方扣不出钱）。
    // 这种情况必须提前说出来，而不是等演示现场第 7 步拿不到哈希才发现。
    let makerVaultBalance = null;
    if (this.readVaultBalance) {
      try {
        makerVaultBalance = (await this.readVaultBalance(this.makerWallet.address)).toString();
        const balance = BigInt(makerVaultBalance);
        const firstBidNeed = (this.midPrice - this.tick) * this.baseQty;
        let fullLadderNeed = 0n;
        for (let i = 1; i <= this.levels; i++) {
          fullLadderNeed += (this.midPrice - this.tick * BigInt(i)) * this.baseQty * BigInt(i);
        }
        if (balance <= 0n) {
          warnings.push(
            `demo maker ${this.makerWallet.address} holds 0 margin in Vault: trades will match off-chain but on-chain settlement will FAIL — fund it first (demo/fund_demo_maker.mjs)`
          );
        } else if (balance < firstBidNeed) {
          warnings.push(
            `demo maker Vault balance ${balance} is below the first bid's settlement need ${firstBidNeed}: even the top-of-book fill can fail on-chain; fund it with demo/fund_demo_maker.mjs`
          );
        } else if (balance < fullLadderNeed) {
          warnings.push(
            `demo maker can settle the top bid (needs ${firstBidNeed}), but balance ${balance} is below the full ${this.levels}-level buy ladder (${fullLadderNeed}); large fills into deeper bids may fail`
          );
        }
      } catch (e) {
        warnings.push(`could not read demo maker vault balance: ${e.message}`);
      }
    }

    const cancelled = await this.cancelOwnOrders();
    const orders = [];
    for (let i = 1; i <= this.levels; i++) {
      const qty = this.baseQty * BigInt(i); // 越远离中间价挂得越厚（典型做市阶梯）
      const bidPrice = this.midPrice - this.tick * BigInt(i);
      const askPrice = this.midPrice + this.tick * BigInt(i);
      // 买单必须带 EIP-712 授权（v2 结算模式），这样演示者的对冲空单吃进来时
      // operator 才能在授权额度内真的把保证金从做市钱包转给演示者。
      const bidBody = {
        traderId: this.makerWallet.address,
        side: "buy",
        price: bidPrice.toString(),
        quantity: qty.toString(),
        type: "limit",
        tif: "GTC",
        leverage: 1,
      };
      const authorization = await this.buildAuthorization(bidPrice, qty);
      if (authorization) bidBody.authorization = authorization;
      const bidRes = await this.post("/orders", bidBody);
      if (bidRes.status === 200 && bidRes.body.order) {
        this.openOrderIds.push(bidRes.body.order.id);
        orders.push(bidRes.body.order);
      } else {
        warnings.push(`bid ${bidPrice} x ${qty} rejected: HTTP ${bidRes.status} ${JSON.stringify(bidRes.body)}`);
      }

      const askRes = await this.post("/orders", {
        traderId: this.makerWallet.address,
        side: "sell",
        price: askPrice.toString(),
        quantity: qty.toString(),
        type: "limit",
        tif: "GTC",
        leverage: 1,
      });
      if (askRes.status === 200 && askRes.body.order) {
        this.openOrderIds.push(askRes.body.order.id);
        orders.push(askRes.body.order);
      } else {
        warnings.push(`ask ${askPrice} x ${qty} rejected: HTTP ${askRes.status} ${JSON.stringify(askRes.body)}`);
      }
    }

    let bestBid = null;
    let bestAsk = null;
    try {
      const bookRes = await this.get("/orderbook");
      if (bookRes.status === 200) {
        bestBid = bookRes.body.bids?.[0]?.price ?? null;
        bestAsk = bookRes.body.asks?.[0]?.price ?? null;
      }
    } catch {}

    this.lastSeedAt = Date.now();
    this.log(`[demo-liquidity] seeded ${orders.length} order(s) around mid=${this.midPrice} (cancelled ${cancelled} stale)`);
    return {
      ok: orders.length > 0,
      maker: this.makerWallet.address,
      cancelled,
      placed: orders.length,
      orders: orders.map((o) => ({ id: o.id, side: o.side, price: o.price, quantity: o.quantity })),
      bestBid,
      bestAsk,
      makerVaultBalance,
      warnings,
    };
  }
}

/** 默认走 HTTP 打到本进程自己的 REST API，复用全部校验/落库/广播逻辑 */
function defaultTransport(get, post) {
  const base = process.env.SELF_API_BASE || `http://127.0.0.1:${process.env.PORT || 4000}`;
  return {
    get:
      get ||
      (async (path) => {
        const res = await fetch(`${base}${path}`);
        return { status: res.status, body: await safeJson(res) };
      }),
    post:
      post ||
      (async (path, body) => {
        const res = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: await safeJson(res) };
      }),
  };
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
