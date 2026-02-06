import type { Exchange, MarketInfo, Order } from "../exchange/types";
import type { TradeEvent } from "../events/trades";
import { PositionStore, type PositionState } from "../persistence/positionStore";
import { roundDownToPrecision, roundToPrecision } from "../util/round";
import { sleep } from "../util/sleep";
import type { Strategy, StrategyContext, StrategyStatus } from "./types";
import { tradeExecuted } from "../db/controllers/trade-executed";

export type MomentumConfig = {
  buyPositionDelta: number;
  sellPositionDelta: number;
  orderPriceDelta: number;
  stopLossDelta: number | null;
  quoteBalanceMinimum: number;
  maxQuoteToSpend: number;

  pricePollMs: number;
  orderPollMs: number;
  orderTimeoutMs: number;
};

const DEFAULTS: MomentumConfig = {
  buyPositionDelta: 0.015,
  sellPositionDelta: 0.02,
  orderPriceDelta: 0.001,
  stopLossDelta: null,
  quoteBalanceMinimum: 0.06,
  maxQuoteToSpend: 25,
  pricePollMs: 1000,
  orderPollMs: 3000,
  orderTimeoutMs: 60_000,
};

function fmt(n: number, d = 2) {
  return n.toFixed(d);
}

export class MomentumStrategy implements Strategy {
  private status: StrategyStatus = "stopped";
  private lastPrice: number | null = null;
  private lastMessage: string | null = null;
  private stopRequested = false;
  private runningPromise: Promise<void> | null = null;
  private emitTrade: ((trade: TradeEvent) => void) | null = null;
  private mode: "paper" | "live" = "paper";
  private exchangeName: string = "unknown";
  private nextTargetBuyPrice: number | undefined = undefined;
  private nextTargetSellPrice: number | undefined = undefined;
  private positionExists: boolean = false;

  private cfg: MomentumConfig;

  constructor(cfg?: Partial<MomentumConfig>) {
    this.cfg = { ...DEFAULTS, ...(cfg ?? {}) };
  }

  getName() {
    return "momentum";
  }

  getStatus() {
    return this.status;
  }

  getLastPrice() {
    return this.lastPrice;
  }

  getLastMessage() {
    return this.lastMessage;
  }

  getPositionExists() {
    return this.positionExists;
  }

  getNextTargetBuyPrice() {
    return this.nextTargetBuyPrice;
  }

  getNextTargetSellPrice() {
    return this.nextTargetSellPrice;
  }

  async start(ctx: StrategyContext): Promise<void> {
    if (this.status === "running") return;
    this.stopRequested = false;
    this.status = "running";
    this.lastMessage = `starting on ${ctx.product} (${ctx.exchange.getName()})`;
    this.emitTrade = ctx.emitTrade;
    this.mode = ctx.mode;
    this.exchangeName = ctx.exchange.getName();

    this.runningPromise = this.run(ctx).catch((err) => {
      this.status = "error";
      this.lastMessage = `error: ${err?.message ?? String(err)}`;
      throw err;
    });

    // Do not await; let it run in background. The HTTP server controls lifecycle.
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.lastMessage = "stop requested";
    try {
      await this.runningPromise;
    } catch {
      // swallow
    } finally {
      this.runningPromise = null;
      this.status = "stopped";
      this.lastMessage = "stopped";
    }
  }

  private async run(ctx: StrategyContext) {
    const exchange = ctx.exchange;
    const store = new PositionStore({ dataDir: ctx.dataDir, name: `${this.getName()}_${ctx.product.replace("/", "-")}` });
    let position: PositionState = store.read();
    this.positionExists = position.positionExists;

    const market = await exchange.loadMarket(ctx.product);

    // CrypFinder-like peak/valley trackers.
    let lastPeak = 0;
    let lastValley = 0;

    // Seed price.
    while (!this.stopRequested && this.lastPrice == null) {
      try {
        const p = await this.fetchAndMaybeFeedPaper(exchange, ctx.product);
        this.lastPrice = p;
        lastPeak = p;
        lastValley = p;
        // Initialize targets, but only expose the one that matches current state
        this.nextTargetBuyPrice = this.positionExists ? undefined : lastValley * (1 + this.cfg.buyPositionDelta);
        this.nextTargetSellPrice = this.positionExists ? lastPeak * (1 - this.cfg.sellPositionDelta) : undefined;
      } catch (e: any) {
        this.lastMessage = `waiting for price: ${e?.message ?? e}`;
        await sleep(500);
      }
    }

    while (!this.stopRequested) {
      let price: number;
      try {
        price = await this.fetchAndMaybeFeedPaper(exchange, ctx.product);
        this.lastPrice = price;
      } catch (e: any) {
        // Don’t crash the whole server on transient ticker timeouts.
        this.lastMessage = `price fetch error: ${e?.message ?? String(e)}`;
        await sleep(Math.min(this.cfg.pricePollMs * 2, 5000));
        continue;
      }

      if (position.positionExists) {
        // Lose position loop
        ({ lastPeak, lastValley, position } = await this.losePosition({
          exchange,
          market,
          price,
          lastPeak,
          lastValley,
          position,
          store,
          symbol: ctx.product,
        }));
      } else {
        // Gain position loop
        ({ lastPeak, lastValley, position } = await this.gainPosition({
          exchange,
          market,
          price,
          lastPeak,
          lastValley,
          position,
          store,
          symbol: ctx.product,
        }));
      }

      // Keep state/targets consistent with current position state
      this.positionExists = position.positionExists;
      if (!this.positionExists && Number.isFinite(lastValley) && lastValley > 0) {
        this.nextTargetBuyPrice = lastValley * (1 + this.cfg.buyPositionDelta);
        this.nextTargetSellPrice = undefined;
      } else if (this.positionExists && Number.isFinite(lastPeak) && lastPeak > 0) {
        this.nextTargetSellPrice = lastPeak * (1 - this.cfg.sellPositionDelta);
        this.nextTargetBuyPrice = undefined;
      }

      await sleep(this.cfg.pricePollMs);
    }
  }

  private async fetchAndMaybeFeedPaper(exchange: Exchange, symbol: string): Promise<number> {
    const price = await exchange.fetchMidPrice(symbol);
    // If this is PaperExchange, it exposes setPrice; duck-type it.
    const maybePaper = exchange as any;
    if (typeof maybePaper.setPrice === "function") maybePaper.setPrice(symbol, price);
    return price;
  }

  private async gainPosition(args: {
    exchange: Exchange;
    market: MarketInfo;
    price: number;
    lastPeak: number;
    lastValley: number;
    position: PositionState;
    store: PositionStore;
    symbol: string;
  }) {
    const { exchange, market, symbol } = args;
    let { price, lastPeak, lastValley, position } = args;

    // Update peak/valley (same intent as old CrypFinder).
    if (price > lastPeak) {
      lastPeak = price;
      const target = lastValley * (1 + this.cfg.buyPositionDelta);
      this.nextTargetBuyPrice = target;
      if (lastPeak >= target) {
        this.lastMessage = `buy signal: peak ${fmt(lastPeak)} >= target ${fmt(target)}`;
        position = await this.tryBuy(exchange, market, symbol, price, position, args.store);
        // Reset trackers after a buy attempt (successful or not)
        lastPeak = price;
        lastValley = price;
        // Now in position (if filled) we should stop showing buy target
        this.positionExists = position.positionExists;
        this.nextTargetBuyPrice = this.positionExists ? undefined : lastValley * (1 + this.cfg.buyPositionDelta);
        this.nextTargetSellPrice = this.positionExists ? lastPeak * (1 - this.cfg.sellPositionDelta) : undefined;
      }
    } else if (price < lastValley) {
      lastValley = price;
      lastPeak = price;
      this.lastMessage = `tracking valley: ${fmt(lastValley)}`;
      this.nextTargetBuyPrice = lastValley * (1 + this.cfg.buyPositionDelta);
    }

    return { lastPeak, lastValley, position };
  }

  private async losePosition(args: {
    exchange: Exchange;
    market: MarketInfo;
    price: number;
    lastPeak: number;
    lastValley: number;
    position: PositionState;
    store: PositionStore;
    symbol: string;
  }) {
    const { exchange, market, symbol } = args;
    let { price, lastPeak, lastValley, position } = args;

    if (price > lastPeak) {
      lastPeak = price;
      lastValley = price;
      this.lastMessage = `tracking peak: ${fmt(lastPeak)}`;
      this.nextTargetSellPrice = lastPeak * (1 - this.cfg.sellPositionDelta);
    } else if (price < lastValley) {
      lastValley = price;
      const target = lastPeak * (1 - this.cfg.sellPositionDelta);
      this.nextTargetSellPrice = target;

      const stopLossEnabled = this.cfg.stopLossDelta != null && position.acquiredPrice != null;
      const stopLossPrice = stopLossEnabled ? position.acquiredPrice! * (1 - this.cfg.stopLossDelta!) : null;

      const shouldSellForProfit = lastValley <= target;
      const shouldStopLoss = stopLossPrice != null && lastValley <= stopLossPrice;

      if (shouldSellForProfit || shouldStopLoss) {
        this.lastMessage = shouldStopLoss
          ? `stop-loss sell signal: ${fmt(lastValley)} <= ${fmt(stopLossPrice!)}`
          : `sell signal: valley ${fmt(lastValley)} <= target ${fmt(target)}`;

        position = await this.trySell(exchange, market, symbol, price, position, args.store);
        lastPeak = price;
        lastValley = price;
        this.positionExists = position.positionExists;
        this.nextTargetSellPrice = this.positionExists ? lastPeak * (1 - this.cfg.sellPositionDelta) : undefined;
        this.nextTargetBuyPrice = this.positionExists ? undefined : lastValley * (1 + this.cfg.buyPositionDelta);
      }
    }

    return { lastPeak, lastValley, position };
  }

  private async tryBuy(exchange: Exchange, market: MarketInfo, symbol: string, currentPrice: number, position: PositionState, store: PositionStore) {
    const balances = await exchange.fetchBalances(symbol);
    const quoteFree = balances.quoteFree;
    const spendable = Math.max(0, Math.min(quoteFree - this.cfg.quoteBalanceMinimum, this.cfg.maxQuoteToSpend));

    if (spendable <= 0) {
      this.lastMessage = `skip buy: insufficient quote balance (free=${fmt(quoteFree)}, min=${fmt(this.cfg.quoteBalanceMinimum)})`;
      return position;
    }

    const price = roundToPrecision(currentPrice * (1 + this.cfg.orderPriceDelta), market.priceDecimals);
    const amountRaw = spendable / price;
    const amount = roundDownToPrecision(amountRaw, market.amountDecimals);

    if (amount <= 0) {
      this.lastMessage = `skip buy: computed amount too small`;
      return position;
    }

    const order = await exchange.placeLimitOrder({ symbol, side: "buy", price, amount });
    const done = await this.waitForFillOrCancel(exchange, symbol, order, store);
    if (done.status !== "closed") {
      this.lastMessage = `buy not filled (${done.status})`;
      return position;
    }

    const fillPrice = done.averageFillPrice ?? done.price;
    const cost = fillPrice * done.filled;
    const fee = done.feePaidQuote ?? 0;

    const next: PositionState = {
      positionExists: true,
      acquiredPrice: fillPrice,
      acquiredCostQuote: cost + fee,
      lastOrderId: done.id,
      lastUpdatedAt: new Date().toISOString(),
    };

    store.write({
      positionExists: true,
      acquiredPrice: fillPrice,
      acquiredCostQuote: cost + fee,
      lastOrderId: done.id,
    });

    this.emitTrade?.({
      ts: new Date().toISOString(),
      strategy: this.getName(),
      exchange: this.exchangeName,
      mode: this.mode,
      symbol,
      side: "buy",
      price: fillPrice,
      amount: done.filled,
      orderId: done.id,
    });
    this.lastMessage = `bought ${done.filled} ${market.base} @ ${fmt(fillPrice, market.priceDecimals)}`;
    return next;
  }

  private async trySell(exchange: Exchange, market: MarketInfo, symbol: string, currentPrice: number, position: PositionState, store: PositionStore) {
    const balances = await exchange.fetchBalances(symbol);
    const baseFree = balances.baseFree;

    const amount = roundDownToPrecision(baseFree, market.amountDecimals);
    if (amount <= 0) {
      this.lastMessage = `skip sell: no base balance`;
      return position;
    }

    const price = roundToPrecision(currentPrice * (1 - this.cfg.orderPriceDelta), market.priceDecimals);
    const order = await exchange.placeLimitOrder({ symbol, side: "sell", price, amount });
    const done = await this.waitForFillOrCancel(exchange, symbol, order, store);
    if (done.status !== "closed") {
      this.lastMessage = `sell not filled (${done.status})`;
      return position;
    }

    const fillPrice = done.averageFillPrice ?? done.price;
    const proceeds = fillPrice * done.filled;
    const fee = done.feePaidQuote ?? 0;
    const acquired = position.acquiredCostQuote ?? 0;
    const profit = proceeds - fee - acquired;

    const next: PositionState = {
      positionExists: false,
      ...(position.acquiredPrice !== undefined ? { acquiredPrice: position.acquiredPrice } : {}),
      ...(position.acquiredCostQuote !== undefined ? { acquiredCostQuote: position.acquiredCostQuote } : {}),
      lastOrderId: done.id,
      lastUpdatedAt: new Date().toISOString(),
    };

    store.write({
      positionExists: false,
      ...(position.acquiredPrice !== undefined ? { acquiredPrice: position.acquiredPrice } : {}),
      ...(position.acquiredCostQuote !== undefined ? { acquiredCostQuote: position.acquiredCostQuote } : {}),
      lastOrderId: done.id,
    });

    this.emitTrade?.({
      ts: new Date().toISOString(),
      strategy: this.getName(),
      exchange: this.exchangeName,
      mode: this.mode,
      symbol,
      side: "sell",
      price: fillPrice,
      amount: done.filled,
      orderId: done.id,
      ...(Number.isFinite(profit) ? { profitQuote: profit } : {}),
    });
    this.lastMessage = `sold ${done.filled} ${market.base} @ ${fmt(fillPrice, market.priceDecimals)} (profit=${fmt(profit)})`;
    return next;
  }

  private async waitForFillOrCancel(exchange: Exchange, symbol: string, order: Order, store: PositionStore): Promise<Order> {
    const start = Date.now();
    let last = order;
    store.write({ positionExists: store.read().positionExists, lastOrderId: order.id });

    while (!this.stopRequested && Date.now() - start < this.cfg.orderTimeoutMs) {
      last = await exchange.fetchOrder(symbol, order.id);
      if (last.status === "closed" || last.status === "canceled" || last.status === "rejected") return last;
      await sleep(this.cfg.orderPollMs);
    }

    try {
      await exchange.cancelOrder(symbol, order.id);
    } catch {
      // ignore cancel failures
    }

    last = await exchange.fetchOrder(symbol, order.id).catch(() => last);
    return last.status === "open" ? { ...last, status: "canceled" } : last;
  }
}


