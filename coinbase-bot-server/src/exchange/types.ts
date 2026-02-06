export type Side = "buy" | "sell";

export type Balances = {
  baseFree: number;
  quoteFree: number;
};

export type MarketInfo = {
  symbol: string; // e.g. BTC/USD
  base: string;
  quote: string;
  priceDecimals: number;
  amountDecimals: number;
};

export type OrderStatus = "open" | "closed" | "canceled" | "rejected" | "unknown";

export type Order = {
  id: string;
  symbol: string;
  side: Side;
  price: number;
  amount: number;
  filled: number;
  status: OrderStatus;
  averageFillPrice?: number;
  feePaidQuote?: number;
  raw?: unknown;
};

export interface Exchange {
  getName(): string;
  loadMarket(symbol: string): Promise<MarketInfo>;
  fetchMidPrice(symbol: string): Promise<number>;
  fetchBalances(symbol: string): Promise<Balances>;
  placeLimitOrder(params: { symbol: string; side: Side; price: number; amount: number }): Promise<Order>;
  fetchOrder(symbol: string, id: string): Promise<Order>;
  cancelOrder(symbol: string, id: string): Promise<void>;
}


