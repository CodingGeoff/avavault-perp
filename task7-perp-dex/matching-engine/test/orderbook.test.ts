import { describe, it, expect, beforeEach } from "vitest";
import { OrderBook } from "../src/orderbook.js";

describe("OrderBook — 基础撮合", () => {
  let book: OrderBook;
  beforeEach(() => {
    book = new OrderBook();
  });

  it("完全没有对手盘时，限价单直接挂单", () => {
    const { order, trades } = book.placeOrder({ traderId: "alice", side: "buy", price: 100n, quantity: 10n });
    expect(trades.length).toBe(0);
    expect(order.status).toBe("open");
    expect(book.getBestBid()).toBe(100n);
  });

  it("价格交叉时立即成交", () => {
    book.placeOrder({ traderId: "alice", side: "buy", price: 100n, quantity: 10n });
    const { order, trades } = book.placeOrder({ traderId: "bob", side: "sell", price: 100n, quantity: 10n });
    expect(trades.length).toBe(1);
    expect(trades[0].price).toBe(100n);
    expect(trades[0].quantity).toBe(10n);
    expect(order.status).toBe("filled");
    expect(book.getBestBid()).toBeNull();
  });

  it("成交价 = 挂单方（maker）的价格，即使 taker 出价更高", () => {
    book.placeOrder({ traderId: "alice", side: "sell", price: 95n, quantity: 5n }); // maker 卖单 95
    const { trades } = book.placeOrder({ traderId: "bob", side: "buy", price: 100n, quantity: 5n }); // taker 愿出 100
    expect(trades[0].price).toBe(95n); // 应该按更优的 maker 价格成交，而不是 taker 出价
  });

  it("部分成交：数量不够时剩余挂单", () => {
    book.placeOrder({ traderId: "alice", side: "sell", price: 100n, quantity: 5n });
    const { order, trades } = book.placeOrder({ traderId: "bob", side: "buy", price: 100n, quantity: 12n });
    expect(trades[0].quantity).toBe(5n);
    expect(order.remaining).toBe(7n);
    expect(order.status).toBe("partially_filled");
    expect(book.getBestBid()).toBe(100n); // 剩余 7 挂在盘口
  });
});

describe("OrderBook — 时间优先（Price-Time Priority）", () => {
  it("同一价位，先下单的先成交", () => {
    const book = new OrderBook();
    const first = book.placeOrder({ traderId: "alice", side: "sell", price: 100n, quantity: 10n }).order;
    const second = book.placeOrder({ traderId: "carol", side: "sell", price: 100n, quantity: 10n }).order;

    // taker 买 10 个，只够吃掉一档；应该吃掉先挂单的 alice，而不是后挂单的 carol
    const { trades } = book.placeOrder({ traderId: "bob", side: "buy", price: 100n, quantity: 10n });

    expect(trades.length).toBe(1);
    expect(trades[0].sellOrderId).toBe(first.id);
    expect(book.getOrder(first.id)!.remaining).toBe(0n);
    expect(book.getOrder(second.id)!.remaining).toBe(10n); // carol 完全没被吃到
  });

  it("同一价位多档挂单，按下单顺序依次消耗，即使后来者数量更小", () => {
    const book = new OrderBook();
    const o1 = book.placeOrder({ traderId: "a1", side: "sell", price: 50n, quantity: 3n }).order;
    const o2 = book.placeOrder({ traderId: "a2", side: "sell", price: 50n, quantity: 3n }).order;
    const o3 = book.placeOrder({ traderId: "a3", side: "sell", price: 50n, quantity: 3n }).order;

    const { trades } = book.placeOrder({ traderId: "taker", side: "buy", price: 50n, quantity: 7n });

    // 期望依次吃掉 o1(3) -> o2(3) -> o3(1)，而不是乱序
    expect(trades.map((t) => t.sellOrderId)).toEqual([o1.id, o2.id, o3.id]);
    expect(trades.map((t) => t.quantity)).toEqual([3n, 3n, 1n]);
    expect(book.getOrder(o3.id)!.remaining).toBe(2n);
  });

  it("更优价格永远优先于时间：后下单但报价更好的应该先成交", () => {
    const book = new OrderBook();
    book.placeOrder({ traderId: "a1", side: "sell", price: 105n, quantity: 5n }); // 先下单，价格较差
    const better = book.placeOrder({ traderId: "a2", side: "sell", price: 100n, quantity: 5n }).order; // 后下单，价格更好

    const { trades } = book.placeOrder({ traderId: "taker", side: "buy", price: 105n, quantity: 5n });
    expect(trades[0].sellOrderId).toBe(better.id);
    expect(trades[0].price).toBe(100n);
  });
});

describe("OrderBook — 自成交保护（Self-Trade Prevention）", () => {
  it("同一个 trader 的对手单不会互相成交，taker 转为挂单", () => {
    const book = new OrderBook();
    const resting = book.placeOrder({ traderId: "alice", side: "buy", price: 100n, quantity: 10n }).order;

    const { order, trades } = book.placeOrder({ traderId: "alice", side: "sell", price: 100n, quantity: 10n });

    expect(trades.length).toBe(0); // 没有发生自成交
    expect(book.getOrder(resting.id)!.remaining).toBe(10n); // 原挂单完全没被动
    expect(order.status).toBe("open"); // taker 自己的单转为挂单（GTC）
    expect(book.getBestAsk()).toBe(100n);
  });

  it("自成交挂单会被跳过，但会继续和其后面不同 trader 的挂单撮合", () => {
    const book = new OrderBook();
    book.placeOrder({ traderId: "alice", side: "sell", price: 100n, quantity: 5n }); // 排在队列前面，稍后会被跳过
    const otherMaker = book.placeOrder({ traderId: "carol", side: "sell", price: 100n, quantity: 5n }).order;

    const { order, trades } = book.placeOrder({ traderId: "alice", side: "buy", price: 100n, quantity: 5n });

    expect(trades.length).toBe(1);
    expect(trades[0].sellOrderId).toBe(otherMaker.id); // 吃到的是 carol 的单，不是自己的
    expect(order.status).toBe("filled");
  });

  it("即使是市价单，也不会与自己的挂单成交", () => {
    const book = new OrderBook();
    book.placeOrder({ traderId: "bob", side: "buy", price: 100n, quantity: 5n });
    const { trades, order } = book.placeOrder({ traderId: "bob", side: "sell", type: "market", quantity: 5n });
    expect(trades.length).toBe(0);
    expect(order.status).toBe("cancelled"); // 市价单，没吃到任何量，等效 IOC 作废
  });
});

describe("OrderBook — TIF: IOC / FOK", () => {
  it("IOC：能成交多少算多少，剩余部分不挂单", () => {
    const book = new OrderBook();
    book.placeOrder({ traderId: "maker", side: "sell", price: 100n, quantity: 4n });
    const { order, trades } = book.placeOrder({
      traderId: "taker",
      side: "buy",
      price: 100n,
      quantity: 10n,
      tif: "IOC",
    });
    expect(trades[0].quantity).toBe(4n);
    expect(order.status).toBe("partially_filled");
    expect(order.remaining).toBe(0n); // IOC 剩余直接作废
    expect(book.getBestBid()).toBeNull(); // 没有挂到盘口上
  });

  it("IOC：完全没有对手盘时整单作废", () => {
    const book = new OrderBook();
    const { order, trades } = book.placeOrder({
      traderId: "taker",
      side: "buy",
      price: 100n,
      quantity: 10n,
      tif: "IOC",
    });
    expect(trades.length).toBe(0);
    expect(order.status).toBe("cancelled");
    expect(book.getBestBid()).toBeNull();
  });

  it("FOK：流动性充足时完整成交", () => {
    const book = new OrderBook();
    book.placeOrder({ traderId: "m1", side: "sell", price: 100n, quantity: 6n });
    book.placeOrder({ traderId: "m2", side: "sell", price: 100n, quantity: 6n });

    const { order, trades } = book.placeOrder({
      traderId: "taker",
      side: "buy",
      price: 100n,
      quantity: 10n,
      tif: "FOK",
    });

    expect(order.status).toBe("filled");
    const totalFilled = trades.reduce((s, t) => s + t.quantity, 0n);
    expect(totalFilled).toBe(10n);
  });

  it("FOK：流动性不足时整单作废，不产生任何成交（不允许部分成交）", () => {
    const book = new OrderBook();
    book.placeOrder({ traderId: "maker", side: "sell", price: 100n, quantity: 3n });

    const { order, trades } = book.placeOrder({
      traderId: "taker",
      side: "buy",
      price: 100n,
      quantity: 10n,
      tif: "FOK",
    });

    expect(trades.length).toBe(0); // 关键：FOK 失败绝不能部分成交
    expect(order.status).toBe("cancelled");
    // 原挂单完全没被动
    expect(book.getBestAsk()).toBe(100n);
    expect(book.getSnapshot().asks[0].quantity).toBe(3n);
  });

  it("FOK 判定会正确排除自成交挂单，即使名义上数量足够也应失败", () => {
    const book = new OrderBook();
    book.placeOrder({ traderId: "alice", side: "sell", price: 100n, quantity: 10n }); // 这单会被自成交跳过
    book.placeOrder({ traderId: "carol", side: "sell", price: 100n, quantity: 3n }); // 真正可用的只有这 3 个

    const { order, trades } = book.placeOrder({
      traderId: "alice",
      side: "buy",
      price: 100n,
      quantity: 10n,
      tif: "FOK",
    });

    expect(trades.length).toBe(0);
    expect(order.status).toBe("cancelled");
  });
});

describe("OrderBook — 市价单", () => {
  it("市价单按最优价格依次吃单，直到吃满或对手盘耗尽", () => {
    const book = new OrderBook();
    book.placeOrder({ traderId: "m1", side: "sell", price: 100n, quantity: 5n });
    book.placeOrder({ traderId: "m2", side: "sell", price: 101n, quantity: 5n });

    const { trades, order } = book.placeOrder({ traderId: "taker", side: "buy", type: "market", quantity: 8n });

    expect(trades[0].price).toBe(100n);
    expect(trades[0].quantity).toBe(5n);
    expect(trades[1].price).toBe(101n);
    expect(trades[1].quantity).toBe(3n);
    expect(order.status).toBe("filled");
  });
});

describe("OrderBook — 撤单", () => {
  it("可以撤销尚未成交的挂单", () => {
    const book = new OrderBook();
    const { order } = book.placeOrder({ traderId: "alice", side: "buy", price: 100n, quantity: 10n });
    expect(book.cancelOrder(order.id)).toBe(true);
    expect(book.getBestBid()).toBeNull();
    expect(book.getOrder(order.id)!.status).toBe("cancelled");
  });

  it("已完全成交的订单不能被撤销", () => {
    const book = new OrderBook();
    const { order } = book.placeOrder({ traderId: "alice", side: "buy", price: 100n, quantity: 10n });
    book.placeOrder({ traderId: "bob", side: "sell", price: 100n, quantity: 10n });
    expect(book.cancelOrder(order.id)).toBe(false);
  });
});

describe("OrderBook — 输入校验", () => {
  it("数量为 0 或负数应该抛错", () => {
    const book = new OrderBook();
    expect(() => book.placeOrder({ traderId: "a", side: "buy", price: 100n, quantity: 0n })).toThrow();
  });

  it("限价单必须指定价格", () => {
    const book = new OrderBook();
    expect(() => book.placeOrder({ traderId: "a", side: "buy", quantity: 1n })).toThrow();
  });

  it("市价单不能是 GTC", () => {
    const book = new OrderBook();
    expect(() =>
      book.placeOrder({ traderId: "a", side: "buy", type: "market", quantity: 1n, tif: "GTC" })
    ).toThrow();
  });
});
