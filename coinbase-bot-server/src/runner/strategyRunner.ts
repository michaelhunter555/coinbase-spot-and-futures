import path from "node:path";
import type { Exchange } from "../exchange/types";
import type { AppConfig, TradingMode } from "../env";
import { CcxtCoinbaseExchange } from "../exchange/ccxtCoinbase";
import { PaperExchange } from "../exchange/paper";
import type { TradeEvent } from "../events/trades";
import { MomentumStrategy } from "../strategies/momentum";
import type { Strategy } from "../strategies/types";

export type RunnerStatus = {
  running: boolean;
  strategy: string | null;
  product: string | null;
  mode: TradingMode | null;
  exchange: string | null;
  lastPrice: number | null;
  lastMessage: string | null;
  positionExists: boolean;
  nextTargetBuyPrice?: number;
  nextTargetSellPrice?: number;
  status: "stopped" | "running" | "error";
};

export class StrategyRunner {
  private strategy: Strategy | null = null;
  private exchange: Exchange | null = null;
  private product: string | null = null;
  private mode: TradingMode | null = null;
  private dataDir: string;
  private tradeHandlers = new Set<(trade: TradeEvent) => void>();

  constructor(private cfg: AppConfig) {
    this.dataDir = path.resolve(process.cwd(), "data");
  }

  onTrade(handler: (trade: TradeEvent) => void) {
    this.tradeHandlers.add(handler);
    return () => this.tradeHandlers.delete(handler);
  }

  getStatus(): RunnerStatus {
    const nextTargetBuyPrice = this.strategy?.getNextTargetBuyPrice();
    const nextTargetSellPrice = this.strategy?.getNextTargetSellPrice();

    return {
      running: this.strategy?.getStatus() === "running",
      strategy: this.strategy?.getName() ?? null,
      product: this.product,
      mode: this.mode,
      exchange: this.exchange?.getName() ?? null,
      lastPrice: this.strategy?.getLastPrice() ?? null,
      lastMessage: this.strategy?.getLastMessage() ?? null,
      positionExists: this.strategy?.getPositionExists() ?? false,
      ...(nextTargetBuyPrice !== undefined ? { nextTargetBuyPrice } : {}),
      ...(nextTargetSellPrice !== undefined ? { nextTargetSellPrice } : {}),
      status: this.strategy?.getStatus() ?? "stopped",
    };
  }

  async start(opts: { product: string; mode: TradingMode }) {
    if (this.strategy?.getStatus() === "running") throw new Error("A strategy is already running");

    this.product = opts.product;
    this.mode = opts.mode;

    this.exchange = this.createExchange(opts.mode);
    this.strategy = new MomentumStrategy({
      buyPositionDelta: this.cfg.buyPositionDelta,
      sellPositionDelta: this.cfg.sellPositionDelta,
      orderPriceDelta: this.cfg.orderPriceDelta,
      stopLossDelta: this.cfg.stopLossDelta,
      quoteBalanceMinimum: this.cfg.quoteBalanceMinimum,
      maxQuoteToSpend: this.cfg.maxQuoteToSpend,
    });

    await this.strategy.start({
      exchange: this.exchange,
      product: opts.product,
      dataDir: this.dataDir,
      mode: opts.mode,
      emitTrade: (t) => {
        for (const h of this.tradeHandlers) h(t);
      },
    });
  }

  async stop() {
    if (!this.strategy) return;
    await this.strategy.stop();
    this.strategy = null;
    this.exchange = null;
    this.product = null;
    this.mode = null;
  }

  private createExchange(mode: TradingMode): Exchange {
    if (mode === "paper") {
      // Seed with a bit of quote so it can simulate trades immediately
      const parts = this.cfg.defaultProduct.split("/");
      const base = parts[0] ?? "BTC";
      const quote = parts[1] ?? "USD";
      return new PaperExchange({ base, quote, quoteAmount: 1000 });
    }

    // live mode
    const opts: { apiKey?: string; secret?: string } = {};
    if (this.cfg.coinbaseApiKey) opts.apiKey = this.cfg.coinbaseApiKey;
    if (this.cfg.coinbaseApiSecret) opts.secret = this.cfg.coinbaseApiSecret;
    return new CcxtCoinbaseExchange(opts);
  }
}


