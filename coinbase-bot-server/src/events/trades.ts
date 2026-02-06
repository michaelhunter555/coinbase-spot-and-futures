export type TradeSide = "buy" | "sell";

export type TradeEvent = {
  ts: string; // ISO timestamp
  strategy: string;
  exchange: string;
  mode: "paper" | "live";
  symbol: string; // e.g. BTC/USD
  side: TradeSide;
  price: number;
  amount: number; // for futures flip runner this is "contracts"
  orderId: string;
  profitQuote?: number; // gross profit (before fees)
  netProfitQuote?: number; // net profit (after fees)
  positionAction?: "open" | "close"; // indicates if this trade opens or closes a position
};


