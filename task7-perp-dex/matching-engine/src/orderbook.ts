import type { BookSnapshot, Order, OrderInput, PlaceOrderResult, Trade } from "./types.js";

/**
 * 一个最小可行、但语义完整的限价撮合引擎。
 *
 * 撮合规则：
 * - 价格优先：买单价格越高越优先成交；卖单价格越低越优先成交。
 * - 时间优先：同价位按下单的单调序号（timestamp）先后排队，先到先得。
 * - 自成交保护（Self-Trade Prevention）：撮合时如果遇到"对手挂单属于同一个 traderId"，
 *   引擎会跳过这笔挂单（不与它成交，也不改变它的状态），继续尝试和它后面的挂单撮合。
 *   这样可以防止同一个交易者通过左手倒右手制造虚假成交量。
 * - TIF：
 *   - GTC（默认）：未成交部分继续挂在盘口上。
 *   - IOC：能成交多少算多少，剩余部分直接作废，不挂单。
 *   - FOK：必须能一次性全部成交，否则整单作废、不产生任何成交（也不会部分成交）。
 * - 市价单（market）：不指定价格，按对手盘从优到劣吃单直至满足数量或对手盘耗尽；
 *   市价单不允许 GTC（未成交部分直接作废，等效于 IOC）。
 */
export class OrderBook {
  private bids: Order[] = []; // 按 price desc, timestamp asc 排序
  private asks: Order[] = []; // 按 price asc, timestamp asc 排序
  private seq = 0;
  private orderSeq = 0;
  private tradeSeq = 0;
  readonly trades: Trade[] = [];
  private ordersById = new Map<string, Order>();

  private nextTimestamp(): number {
    return ++this.seq;
  }

  private nextOrderId(): string {
    return `order-${++this.orderSeq}`;
  }

  private nextTradeId(): string {
    return `trade-${++this.tradeSeq}`;
  }

  getOrder(id: string): Order | undefined {
    return this.ordersById.get(id);
  }

  /**
   * 从持久化存储（如 SQLite）恢复一个"已经存在、仍在挂单中"的订单，直接插入盘口，
   * 不重新触发撮合（因为它在写入 DB 之前已经撮合过一次了）。用于服务重启后重建订单簿。
   * 同时会推进内部的序号计数器，避免恢复后新订单的 id/timestamp 与历史重复。
   */
  restoreOpenOrder(order: Order): void {
    this.ordersById.set(order.id, order);
    this.insertResting(order);
    const idNum = Number(order.id.replace("order-", ""));
    if (Number.isFinite(idNum) && idNum > this.orderSeq) this.orderSeq = idNum;
    if (order.timestamp > this.seq) this.seq = order.timestamp;
  }

  /** 重启后同步已成交的 trade 序号，避免新成交的 id 与历史重复 */
  fastForwardTradeSeq(lastTradeId: string): void {
    const idNum = Number(lastTradeId.replace("trade-", ""));
    if (Number.isFinite(idNum) && idNum > this.tradeSeq) this.tradeSeq = idNum;
  }

  /** 判断 taker 是否可以和 maker 的价格发生撮合 */
  private crosses(takerSide: "buy" | "sell", takerPrice: bigint | null, makerPrice: bigint): boolean {
    if (takerPrice === null) return true; // 市价单永远可以吃到对手盘（只要对手盘存在）
    return takerSide === "buy" ? takerPrice >= makerPrice : takerPrice <= makerPrice;
  }

  /**
   * 在不修改任何状态的前提下，模拟一次撮合，返回"排除自成交挂单后，理论上最多能成交多少数量"。
   * 用于 FOK 判定：必须完全可成交才真正执行。
   */
  private simulateFillable(traderId: string, side: "buy" | "sell", price: bigint | null, quantity: bigint): bigint {
    const book = side === "buy" ? this.asks : this.bids;
    let remaining = quantity;
    for (const maker of book) {
      if (remaining <= 0n) break;
      if (!this.crosses(side, price, maker.price)) break;
      if (maker.traderId === traderId) continue; // 自成交跳过
      const qty = remaining < maker.remaining ? remaining : maker.remaining;
      remaining -= qty;
    }
    return quantity - remaining;
  }

  private insertResting(order: Order) {
    const book = order.side === "buy" ? this.bids : this.asks;
    // 找到插入位置：价格优先，同价按 timestamp 升序（先到先得）
    let idx = book.length;
    for (let i = 0; i < book.length; i++) {
      const better =
        order.side === "buy" ? order.price > book[i].price : order.price < book[i].price;
      const samePrice = order.price === book[i].price;
      if (better || (samePrice && order.timestamp < book[i].timestamp)) {
        idx = i;
        break;
      }
    }
    book.splice(idx, 0, order);
  }

  private matchAgainstBook(taker: Order): Trade[] {
    const book = taker.side === "buy" ? this.asks : this.bids;
    const trades: Trade[] = [];
    let i = 0;
    while (taker.remaining > 0n && i < book.length) {
      const maker = book[i];
      if (!this.crosses(taker.side, taker.type === "market" ? null : taker.price, maker.price)) {
        break; // 价格不再交叉，停止撮合
      }
      if (maker.traderId === taker.traderId) {
        i++; // 自成交保护：跳过，不成交，继续看后面的挂单
        continue;
      }

      const qty = taker.remaining < maker.remaining ? taker.remaining : maker.remaining;
      const trade: Trade = {
        id: this.nextTradeId(),
        price: maker.price, // 成交价 = 挂单方（maker）的价格
        quantity: qty,
        buyOrderId: taker.side === "buy" ? taker.id : maker.id,
        sellOrderId: taker.side === "sell" ? taker.id : maker.id,
        buyTraderId: taker.side === "buy" ? taker.traderId : maker.traderId,
        sellTraderId: taker.side === "sell" ? taker.traderId : maker.traderId,
        timestamp: this.nextTimestamp(),
      };
      trades.push(trade);
      this.trades.push(trade);

      taker.remaining -= qty;
      maker.remaining -= qty;

      if (maker.remaining === 0n) {
        maker.status = "filled";
        book.splice(i, 1); // 移除已完全成交的挂单，索引不变即指向下一个元素
      } else {
        maker.status = "partially_filled";
        i++;
      }
    }
    return trades;
  }

  placeOrder(input: OrderInput): PlaceOrderResult {
    if (input.quantity <= 0n) throw new Error("quantity must be > 0");
    if (input.type === "limit" || input.type === undefined) {
      if (input.price === undefined || input.price <= 0n) {
        throw new Error("limit order requires price > 0");
      }
    }

    const type = input.type ?? "limit";
    const tif = input.tif ?? (type === "market" ? "IOC" : "GTC");
    if (type === "market" && tif === "GTC") {
      throw new Error("market order cannot be GTC");
    }

    const order: Order = {
      id: this.nextOrderId(),
      traderId: input.traderId,
      side: input.side,
      type,
      price: type === "market" ? (input.side === "buy" ? 2n ** 255n : 0n) : (input.price as bigint),
      quantity: input.quantity,
      remaining: input.quantity,
      tif,
      timestamp: this.nextTimestamp(),
      status: "open",
    };
    this.ordersById.set(order.id, order);

    if (tif === "FOK") {
      const fillable = this.simulateFillable(
        order.traderId,
        order.side,
        type === "market" ? null : order.price,
        order.quantity
      );
      if (fillable < order.quantity) {
        order.status = "cancelled";
        order.remaining = order.quantity; // FOK 失败：完全不执行，不产生任何成交
        return { order, trades: [] };
      }
    }

    const trades = this.matchAgainstBook(order);

    if (order.remaining === 0n) {
      order.status = "filled";
      return { order, trades };
    }

    if (tif === "GTC") {
      order.status = trades.length > 0 ? "partially_filled" : "open";
      this.insertResting(order);
    } else {
      // IOC / FOK 且未完全成交：剩余部分作废，不挂单
      order.status = trades.length > 0 ? "partially_filled" : "cancelled";
      order.remaining = 0n; // 明确表示不再挂在盘口上
    }

    return { order, trades };
  }

  cancelOrder(id: string): boolean {
    const order = this.ordersById.get(id);
    if (!order || order.status === "filled" || order.status === "cancelled") return false;
    const book = order.side === "buy" ? this.bids : this.asks;
    const idx = book.findIndex((o) => o.id === id);
    if (idx >= 0) book.splice(idx, 1);
    order.status = "cancelled";
    order.remaining = 0n;
    return true;
  }

  getSnapshot(depth = 10): BookSnapshot {
    const aggregate = (orders: Order[]) => {
      const map = new Map<string, bigint>();
      for (const o of orders) {
        map.set(o.price.toString(), (map.get(o.price.toString()) ?? 0n) + o.remaining);
      }
      return Array.from(map.entries())
        .map(([p, q]) => ({ price: BigInt(p), quantity: q }))
        .slice(0, depth);
    };
    return { bids: aggregate(this.bids), asks: aggregate(this.asks) };
  }

  getBestBid(): bigint | null {
    return this.bids.length ? this.bids[0].price : null;
  }

  getBestAsk(): bigint | null {
    return this.asks.length ? this.asks[0].price : null;
  }
}
