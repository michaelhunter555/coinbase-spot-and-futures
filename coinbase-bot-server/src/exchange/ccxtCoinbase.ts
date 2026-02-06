import ccxt from "ccxt";
import type { Balances, Exchange, MarketInfo, Order, OrderStatus, Side } from "./types";

function statusFromCcxt(s: string | undefined): OrderStatus {
  if (!s) return "unknown";
  const norm = s.toLowerCase();
  if (norm === "open") return "open";
  if (norm === "closed") return "closed";
  if (norm === "canceled" || norm === "cancelled") return "canceled";
  if (norm === "rejected") return "rejected";
  return "unknown";
}

function precisionToDecimals(p: unknown): number {
  if (typeof p === "number" && Number.isFinite(p)) return p;
  return 8; // sensible default
}

export class CcxtCoinbaseExchange implements Exchange {
  private ex: any;

  constructor(opts: { apiKey?: string; secret?: string }) {
    // NOTE: CCXT exchange id is "coinbase". This is not Coinbase Pro.
    // If your account/keys require a different exchange id, swap here.
    this.ex = new ccxt.coinbase({
      apiKey: opts.apiKey,
      secret: opts.secret,
      enableRateLimit: true,
    });
  }

  getName() {
    return "ccxt:coinbase";
  }

  async loadMarket(symbol: string): Promise<MarketInfo> {
    const markets = await this.ex.loadMarkets();
    const m = markets[symbol];
    if (!m) throw new Error(`Market not found for symbol "${symbol}" on ${this.getName()}`);
    return {
      symbol,
      base: m.base,
      quote: m.quote,
      priceDecimals: precisionToDecimals(m.precision?.price),
      amountDecimals: precisionToDecimals(m.precision?.amount),
    };
  }

  async fetchMidPrice(symbol: string): Promise<number> {
    const t = await this.ex.fetchTicker(symbol);
    const mid =
      (typeof t.bid === "number" && typeof t.ask === "number" && t.bid > 0 && t.ask > 0)
        ? (t.bid + t.ask) / 2
        : typeof t.last === "number"
          ? t.last
          : null;
    if (mid == null || !Number.isFinite(mid)) throw new Error(`Failed to fetch price for ${symbol}`);
    return mid;
  }

  async fetchBalances(symbol: string): Promise<Balances> {
    const market = await this.loadMarket(symbol);
    const bal = await this.ex.fetchBalance();
    const baseFree = bal.free?.[market.base];
    const quoteFree = bal.free?.[market.quote];
    return {
      baseFree: typeof baseFree === "number" ? baseFree : 0,
      quoteFree: typeof quoteFree === "number" ? quoteFree : 0,
    };
  }

  async placeLimitOrder(params: { symbol: string; side: Side; price: number; amount: number }): Promise<Order> {
    const o =
      params.side === "buy"
        ? await this.ex.createLimitBuyOrder(params.symbol, params.amount, params.price)
        : await this.ex.createLimitSellOrder(params.symbol, params.amount, params.price);

    return {
      id: String(o.id),
      symbol: params.symbol,
      side: params.side,
      price: params.price,
      amount: params.amount,
      filled: typeof o.filled === "number" ? o.filled : 0,
      status: statusFromCcxt(o.status),
      averageFillPrice: typeof o.average === "number" ? o.average : undefined,
      feePaidQuote: typeof o.fee?.cost === "number" ? o.fee.cost : undefined,
      raw: o,
    };
  }

  async fetchOrder(symbol: string, id: string): Promise<Order> {
    const o = await this.ex.fetchOrder(id, symbol);
    return {
      id: String(o.id),
      symbol,
      side: (o.side === "buy" ? "buy" : "sell") as Side,
      price: typeof o.price === "number" ? o.price : 0,
      amount: typeof o.amount === "number" ? o.amount : 0,
      filled: typeof o.filled === "number" ? o.filled : 0,
      status: statusFromCcxt(o.status),
      averageFillPrice: typeof o.average === "number" ? o.average : undefined,
      feePaidQuote: typeof o.fee?.cost === "number" ? o.fee.cost : undefined,
      raw: o,
    };
  }

  async cancelOrder(symbol: string, id: string): Promise<void> {
    await this.ex.cancelOrder(id, symbol);
  }
}


