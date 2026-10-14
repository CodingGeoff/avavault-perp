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

CREATE TABLE IF NOT EXISTS sessions (
  address TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  traderId TEXT PRIMARY KEY,
  sizeSigned TEXT NOT NULL,
  entryPrice TEXT NOT NULL,
  marginAllocated TEXT NOT NULL,
  leverage INTEGER NOT NULL,
  realizedPnl TEXT NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clearing_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

/** 清算层状态（保险基金余额/累计兜底/累计坏账）的键值落库 */
export function setClearingValue(key, value) {
  db.prepare(
    `INSERT INTO clearing_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(key, String(value));
}

export function getClearingValue(key) {
  const row = db.prepare(`SELECT value FROM clearing_state WHERE key = ?`).get(key);
  return row ? row.value : null;
}

/** 仓位落库（永续仓位引擎的状态，重启后恢复未平仓位而不是从零开始） */
export function persistPosition(serialized) {
  db.prepare(
    `INSERT INTO positions (traderId, sizeSigned, entryPrice, marginAllocated, leverage, realizedPnl, cumulativeFunding, updatedAt)
     VALUES (@traderId, @sizeSigned, @entryPrice, @marginAllocated, @leverage, @realizedPnl, @cumulativeFunding, @updatedAt)
     ON CONFLICT(traderId) DO UPDATE SET sizeSigned=excluded.sizeSigned, entryPrice=excluded.entryPrice,
       marginAllocated=excluded.marginAllocated, leverage=excluded.leverage,
       realizedPnl=excluded.realizedPnl, cumulativeFunding=excluded.cumulativeFunding, updatedAt=excluded.updatedAt`
  ).run({ ...serialized, cumulativeFunding: serialized.cumulativeFunding ?? "0", updatedAt: Date.now() });
}

export function loadPositions() {
  return db.prepare(`SELECT * FROM positions WHERE sizeSigned != '0'`).all();
}

/** 登录会话落库：进程重启（免费层休眠唤醒/重新部署）后用户不用重新签名登录 */
export function persistSession(address, token) {
  db.prepare(
    `INSERT INTO sessions (address, token, createdAt) VALUES (?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET token=excluded.token, createdAt=excluded.createdAt`
  ).run(String(address).toLowerCase(), token, Date.now());
}

/** 载入未过期的会话（默认 7 天），过期的顺手清掉 */
export function loadSessions(maxAgeMs = 7 * 24 * 3600 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  db.prepare(`DELETE FROM sessions WHERE createdAt < ?`).run(cutoff);
  return db.prepare(`SELECT * FROM sessions WHERE createdAt >= ?`).all(cutoff);
}

// 迁移：老库的 orders 表没有 authorization 列。v2 结算模式下买单携带的 EIP-712
// 授权以前只存在服务端内存里，进程一重启（如免费层休眠唤醒/重新部署）就丢失，
// 挂在盘口上的买单成交后将无法链上结算。这里把授权随订单一起落库，重启恢复
// 订单簿时一并恢复授权。已经部署过的老数据库靠下面这段幂等迁移补列，不需要删库。
const orderColumns = db.prepare(`PRAGMA table_info(orders)`).all().map((c) => c.name);
if (!orderColumns.includes("authorization")) {
  db.exec(`ALTER TABLE orders ADD COLUMN authorization TEXT`);
}
if (!orderColumns.includes("leverage")) {
  db.exec(`ALTER TABLE orders ADD COLUMN leverage INTEGER NOT NULL DEFAULT 1`);
}
// 迁移：老库的 positions 表没有 cumulativeFunding 列（资金费累计现金流）
const positionColumns = db.prepare(`PRAGMA table_info(positions)`).all().map((c) => c.name);
if (!positionColumns.includes("cumulativeFunding")) {
  db.exec(`ALTER TABLE positions ADD COLUMN cumulativeFunding TEXT NOT NULL DEFAULT '0'`);
}

const upsertOrderStmt = db.prepare(`
  INSERT INTO orders (id, traderId, side, type, price, quantity, remaining, tif, status, timestamp, createdAt, authorization, leverage)
  VALUES (@id, @traderId, @side, @type, @price, @quantity, @remaining, @tif, @status, @timestamp, @createdAt, @authorization, @leverage)
  ON CONFLICT(id) DO UPDATE SET remaining=excluded.remaining, status=excluded.status,
    authorization=COALESCE(excluded.authorization, orders.authorization)
`);

/**
 * 只更新/插入一个订单的最新状态（用于持久化因撮合而被动变化的 maker 挂单）。
 * `authorization` 只在订单刚下达时由调用方传入；之后 maker 状态被动变化时不传，
 * 靠上面 COALESCE 保留已存的授权，避免把已落库的签名抹掉。
 */
export function persistOrderState(order, authorization = null) {
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
    authorization: authorization ? JSON.stringify(authorization) : null,
    leverage: Number.isInteger(order.leverage) ? order.leverage : 1,
  });
}

/**
 * 持久化一次 placeOrder 的结果（重启后订单簿状态/历史成交不丢失）。
 * 注意：这里只写入本次的 taker 订单和新增成交记录；如果这次撮合还动到了盘口里
 * 已存在的 maker 挂单（导致它们 remaining/status 变化），调用方需要另外调用
 * `persistOrderState()` 把这些 maker 订单的最新状态也落库，否则重启后会读到
 * "看起来还挂着、实际上早就被吃掉"的过期数据。
 */
export function persistOrderResult(order, trades, authorization = null) {
  persistOrderState(order, authorization);

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
