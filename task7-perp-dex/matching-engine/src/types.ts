export type Side = "buy" | "sell";
export type OrderType = "limit" | "market";
/** GTC = Good-Til-Cancelled（默认，挂单）；IOC = Immediate-Or-Cancel；FOK = Fill-Or-Kill */
export type TimeInForce = "GTC" | "IOC" | "FOK";

export interface OrderInput {
  traderId: string;
  side: Side;
  /** 市价单可省略 price */
  price?: bigint;
  quantity: bigint;
  type?: OrderType;
  tif?: TimeInForce;
}

export interface Order {
  id: string;
  traderId: string;
  side: Side;
  type: OrderType;
  price: bigint; // 市价单内部用 0(buy 用 +Infinity 语义, sell 用 0 语义) 表示，不直接暴露
  quantity: bigint;
  remaining: bigint;
  tif: TimeInForce;
  timestamp: number; // 单调递增序号，决定同价位的时间优先级
  status: "open" | "filled" | "partially_filled" | "cancelled";
}

export interface Trade {
  id: string;
  price: bigint;
  quantity: bigint;
  buyOrderId: string;
  sellOrderId: string;
  buyTraderId: string;
  sellTraderId: string;
  timestamp: number;
}

export interface PlaceOrderResult {
  order: Order;
  trades: Trade[];
}

export interface BookLevel {
  price: bigint;
  quantity: bigint;
}

export interface BookSnapshot {
  bids: BookLevel[];
  asks: BookLevel[];
}
