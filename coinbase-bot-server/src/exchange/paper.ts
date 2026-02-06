import crypto from "node:crypto";
import ccxt from "ccxt";
import type { Balances, Exchange, MarketInfo, Order, Side } from "./types";

type PaperState = {
  market: MarketInfo | null;
  lastPrice: number | null;
  balances: Record<string, number>; // currency -> free
  orders: Map<string, Order>;
};

export class PaperExchange implements Exchange {
  private state: PaperState;
  private publicEx: any;
  private lastFetchAtMs = 0;
  private minFetchIntervalMs = 1000;
  private lastFetchErrorAtMs = 0;
  private errorBackoffMs = 3000;

  constructor(seed?: { base?: string; quote?: string; baseAmount?: number; quoteAmount?: number }) {
    this.state = {
      market: null,
      lastPrice: null,
      balances: {},
      orders: new Map(),
    };

    // Public price feed (no keys) so paper mode can still follow real prices
    this.publicEx = new ccxt.coinbase({
      enableRateLimit: true,
      timeout: 30_000,
    });

    if (seed?.base) this.state.balances[seed.base] = seed.baseAmount ?? 0;
    if (seed?.quote) this.state.balances[seed.quote] = seed.quoteAmount ?? 1000;
  }

  getName() {
    return "paper";
  }

  async loadMarket(symbol: string): Promise<MarketInfo> {
    const [base, quote] = symbol.split("/");
    if (!base || !quote) throw new Error(`Invalid symbol "${symbol}" (expected BASE/QUOTE)`);

    // Default to common crypto precisions.
    const market: MarketInfo = {
      symbol,
      base,
      quote,
      priceDecimals: 2,
      amountDecimals: 8,
    };

    this.state.market = market;
    this.state.balances[base] ??= 0;
    this.state.balances[quote] ??= 1000;

    return market;
  }

  setPrice(symbol: string, price: number) {
    if (!Number.isFinite(price) || price <= 0) return;
    if (!this.state.market || this.state.market.symbol !== symbol) return;
    this.state.lastPrice = price;
  }

  async fetchMidPrice(symbol: string): Promise<number> {
    if (!this.state.market || this.state.market.symbol !== symbol) await this.loadMarket(symbol);
    const now = Date.now();

    // Throttle public fetches (strategy calls once/sec by default)
    if (this.state.lastPrice != null && now - this.lastFetchAtMs < this.minFetchIntervalMs) {
      return this.state.lastPrice;
    }

    // If we recently had a fetch error, back off and use last known price if we have one.
    if (this.state.lastPrice != null && now - this.lastFetchErrorAtMs < this.errorBackoffMs) {
      return this.state.lastPrice;
    }

    // Pull a public ticker so the strategy can follow real prices in paper mode
    try {
      const t = await this.publicEx.fetchTicker(symbol);
      const mid =
        (typeof t.bid === "number" && typeof t.ask === "number" && t.bid > 0 && t.ask > 0)
          ? (t.bid + t.ask) / 2
          : typeof t.last === "number"
            ? t.last
            : null;
      if (mid == null || !Number.isFinite(mid)) throw new Error(`PaperExchange failed to fetch price for ${symbol}`);
      this.state.lastPrice = mid;
      this.lastFetchAtMs = now;
      return mid;
    } catch (e) {
      this.lastFetchErrorAtMs = now;
      // If we have a last known price, keep the bot alive; otherwise bubble up.
      if (this.state.lastPrice != null) return this.state.lastPrice;
      throw e;
    }
  }

  async fetchBalances(symbol: string): Promise<Balances> {
    const market = await this.loadMarket(symbol);
    return {
      baseFree: this.state.balances[market.base] ?? 0,
      quoteFree: this.state.balances[market.quote] ?? 0,
    };
  }

  async placeLimitOrder(params: { symbol: string; side: Side; price: number; amount: number }): Promise<Order> {
    const market = await this.loadMarket(params.symbol);
    const id = crypto.randomUUID();
    const order: Order = {
      id,
      symbol: params.symbol,
      side: params.side,
      price: params.price,
      amount: params.amount,
      filled: 0,
      status: "open",
    };
    this.state.orders.set(id, order);

    // Naive fill model: execute instantly at requested price if affordable.
    const feeRate = 0.006; // ~0.6% worst-case, intentionally conservative

    if (params.side === "buy") {
      const cost = params.price * params.amount;
      const fee = cost * feeRate;
      const quoteFree = this.state.balances[market.quote] ?? 0;
      if (quoteFree >= cost + fee) {
        this.state.balances[market.quote] = quoteFree - (cost + fee);
        this.state.balances[market.base] = (this.state.balances[market.base] ?? 0) + params.amount;
        order.filled = params.amount;
        order.status = "closed";
        order.averageFillPrice = params.price;
        order.feePaidQuote = fee;
      } else {
        order.status = "rejected";
      }
    } else {
      const baseFree = this.state.balances[market.base] ?? 0;
      if (baseFree >= params.amount) {
        const proceeds = params.price * params.amount;
        const fee = proceeds * feeRate;
        this.state.balances[market.base] = baseFree - params.amount;
        this.state.balances[market.quote] = (this.state.balances[market.quote] ?? 0) + (proceeds - fee);
        order.filled = params.amount;
        order.status = "closed";
        order.averageFillPrice = params.price;
        order.feePaidQuote = fee;
      } else {
        order.status = "rejected";
      }
    }

    return order;
  }

  async fetchOrder(_symbol: string, id: string): Promise<Order> {
    const o = this.state.orders.get(id);
    if (!o) throw new Error(`Paper order not found: ${id}`);
    return o;
  }

  async cancelOrder(_symbol: string, id: string): Promise<void> {
    const o = this.state.orders.get(id);
    if (!o) return;
    if (o.status === "open") o.status = "canceled";
  }
}


