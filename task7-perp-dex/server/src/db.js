import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "mini-dex.sqlite");

import fs from "node:fs";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  traderId TEXT NOT NULL,
  side TEXT NOT NULL,
  type TEXT NOT NULL,
  price TEXT NOT NULL,
  quantity TEXT NOT NULL,
  remaining TEXT NOT NULL,
  tif TEXT NOT NULL,
  status TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  price TEXT NOT NULL,
  quantity TEXT NOT NULL,
  buyOrderId TEXT NOT NULL,
  sellOrderId TEXT NOT NULL,
  buyTraderId TEXT NOT NULL,
  sellTraderId TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  settledTxHash TEXT
);
`);

const upsertOrderStmt = db.prepare(`
  INSERT INTO orders (id, traderId, side, type, price, quantity, remaining, tif, status, timestamp, createdAt)
  VALUES (@id, @traderId, @side, @type, @price, @quantity, @remaining, @tif, @status, @timestamp, @createdAt)
  ON CONFLICT(id) DO UPDATE SET remaining=excluded.remaining, status=excluded.status
`);

/** 只更新/插入一个订单的最新状态（用于持久化因撮合而被动变化的 maker 挂单） */
export function persistOrderState(order) {
  upsertOrderStmt.run({
    id: order.id,
    traderId: order.traderId,
    side: order.side,
    type: order.type,
    price: order.price.toString(),
    quantity: order.quantity.toString(),
    remaining: order.remaining.toString(),
    tif: order.tif,
    status: order.status,
    timestamp: order.timestamp,
    createdAt: Date.now(),
  });
}

/**
 * 持久化一次 placeOrder 的结果（重启后订单簿状态/历史成交不丢失）。
 * 注意：这里只写入本次的 taker 订单和新增成交记录；如果这次撮合还动到了盘口里
 * 已存在的 maker 挂单（导致它们 remaining/status 变化），调用方需要另外调用
 * `persistOrderState()` 把这些 maker 订单的最新状态也落库，否则重启后会读到
 * "看起来还挂着、实际上早就被吃掉"的过期数据。
 */
export function persistOrderResult(order, trades) {
  persistOrderState(order);

  const insertTrade = db.prepare(`
    INSERT OR IGNORE INTO trades (id, price, quantity, buyOrderId, sellOrderId, buyTraderId, sellTraderId, timestamp)
    VALUES (@id, @price, @quantity, @buyOrderId, @sellOrderId, @buyTraderId, @sellTraderId, @timestamp)
  `);
  for (const t of trades) {
    insertTrade.run({
      id: t.id,
      price: t.price.toString(),
      quantity: t.quantity.toString(),
      buyOrderId: t.buyOrderId,
      sellOrderId: t.sellOrderId,
      buyTraderId: t.buyTraderId,
      sellTraderId: t.sellTraderId,
      timestamp: t.timestamp,
    });
  }
}

export function markTradeSettled(tradeId, txHash) {
  db.prepare(`UPDATE trades SET settledTxHash = ? WHERE id = ?`).run(txHash, tradeId);
}

export function loadRecentTrades(limit = 50) {
  return db.prepare(`SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?`).all(limit);
}

export function loadOpenOrders() {
  return db.prepare(`SELECT * FROM orders WHERE status IN ('open','partially_filled')`).all();
}
