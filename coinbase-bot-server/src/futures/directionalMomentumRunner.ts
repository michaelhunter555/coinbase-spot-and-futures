import ccxt from "ccxt";
import { sleep } from "../util/sleep";
import type { TradeEvent } from "../events/trades";
import {
  closeFuturesPosition,
  getFuturesMarket,
  placeFuturesOrder,
  type FuturesOrderRequest,
} from "./cfmFutures";

export type DirectionalMode = "preview" | "live";

export type DirectionalConfig = {
  /**
   * For LONG mode: how far price must bounce up from a valley to enter long (e.g. 0.01 = +1% from valley)
   * For SHORT mode: how far price must drop from a peak to enter short (e.g. 0.01 = -1% from peak)
   */
  buyDelta: number;
  sellDelta: number;

  /**
   * Poll interval for price checks in milliseconds.
   */
  pollMs: number;

  retail_portfolio_id?: string;

  // Fee / profit-lock configuration (same semantics as flip runner, but for single-leg)
  feeGateEnabled?: boolean;
  takerFeeRate?: number; // e.g. 0.001 = 0.10%
  perContractFeeUsd?: number; // e.g. 0.15 per contract per side
  profitLockThreshold?: number; // e.g. 0.01 = 1% net profit to activate lock
  trailingDistance?: number; // e.g. 0.01 = trail 1% below high-water profit
};

export type DirectionalStatus = {
  running: boolean;
  mode: DirectionalMode | null;
  symbol: string | null;
  contracts: number | null;
  desiredSide: "long" | "short" | null;
  side: "flat" | "long" | "short";
  lastPrice: number | null;
  lastMessage: string | null;
  contractSize?: number;

  // Momentum tracking
  lastPeak?: number;
  lastValley?: number;
  nextEntryPrice?: number;

  // PnL / profit lock
  entryPrice?: number;
  estimatedGrossPnl?: number;
  estimatedNetPnl?: number;
  profitLocked?: boolean;
  maxProfitAchieved?: number; // net % high-water mark
  trailingStopPrice?: number;
};

type Ctx = {
  apiKey: string;
  secret: string;
  emitTrade: (t: TradeEvent) => void;
  onStatus?: (s: DirectionalStatus) => void;
};

function createPublicCoinbaseAdvanced() {
  const ExchangeCtor = (ccxt as any)["coinbaseadvanced"] ?? (ccxt as any)["coinbase"];
  return new ExchangeCtor({ enableRateLimit: true, timeout: 30_000 });
}

export class FuturesDirectionalMomentumRunner {
  private stopRequested = false;
  private runningPromise: Promise<void> | null = null;
  private currentCtx: Ctx | null = null;
  private currentConfig: { mode: DirectionalMode; symbol: string; contracts: number; side: "long" | "short"; cfg: DirectionalConfig } | null = null;

  private status: DirectionalStatus = {
    running: false,
    mode: null,
    symbol: null,
    contracts: null,
    desiredSide: null,
    side: "flat",
    lastPrice: null,
    lastMessage: null,
  };

  getStatus() {
    return this.status;
  }

  private setStatus(ctx: Ctx | null, patch: Partial<DirectionalStatus>) {
    this.status = { ...this.status, ...patch };
    ctx?.onStatus?.(this.status);
  }

  async start(
    ctx: Ctx,
    opts: { mode: DirectionalMode; symbol: string; contracts: number; side: "long" | "short"; cfg: DirectionalConfig },
  ) {
    if (this.status.running) throw new Error("Directional momentum already running");
    this.stopRequested = false;
    this.currentCtx = ctx;
    this.currentConfig = opts;

    this.status = {
      running: true,
      mode: opts.mode,
      symbol: opts.symbol,
      contracts: opts.contracts,
      desiredSide: opts.side,
      side: "flat",
      lastPrice: null,
      lastMessage: `starting futures directional momentum (${opts.side}) on ${opts.symbol} (${opts.mode})`,
    };
    ctx.onStatus?.(this.status);

    // Load market once so we know contractSize for fee/PnL estimation.
    try {
      const m = await getFuturesMarket({ apiKey: ctx.apiKey, secret: ctx.secret, symbol: opts.symbol });
      const contractSize = Number((m.market as any)?.contractSize);
      if (Number.isFinite(contractSize) && contractSize > 0) {
        this.status = { ...this.status, contractSize };
        ctx.onStatus?.(this.status);
      }
    } catch (e: any) {
      this.status = {
        ...this.status,
        lastMessage: `warning: failed to load market (contractSize unknown): ${e?.message ?? String(e)}`,
      };
      ctx.onStatus?.(this.status);
    }

    this.runningPromise = this.run(ctx, opts).catch((e) => {
      this.status = { ...this.status, running: false, lastMessage: `error: ${e?.message ?? String(e)}` };
      ctx.onStatus?.(this.status);
    });
  }

  async stop(ctx?: { onStatus?: (s: DirectionalStatus) => void }) {
    this.stopRequested = true;

    // Close any open position before stopping
    if (this.status.side !== "flat" && this.currentCtx && this.currentConfig) {
      try {
        let currentPrice = this.status.lastPrice ?? 0;
        if (currentPrice === 0 && this.currentConfig.symbol) {
          try {
            currentPrice = await this.fetchPrice(this.currentConfig.symbol);
          } catch {
            // ignore, we'll use 0 and let the market order handle it
          }
        }
        const contracts = Math.abs(this.currentConfig.contracts);
        const contractSize = this.status.contractSize ?? 1;
        const entryPrice = this.status.entryPrice;
        let profitQuote: number | undefined;
        let netProfitQuote: number | undefined;
        if (entryPrice != null) {
          if (this.status.side === "long") {
            profitQuote = (currentPrice - entryPrice) * contracts * contractSize;
          } else {
            profitQuote = (entryPrice - currentPrice) * contracts * contractSize;
          }
          const closeFees = this.calculateFeesForClose(
            { contracts, cfg: this.currentConfig.cfg },
            entryPrice,
            currentPrice,
            contractSize,
          );
          netProfitQuote = profitQuote - closeFees;
        }

        const closeResult = await closeFuturesPosition({
          apiKey: this.currentCtx.apiKey,
          secret: this.currentCtx.secret,
          symbol: this.currentConfig.symbol,
        });

        const closeTrade: any = {
          ts: new Date().toISOString(),
          strategy: "futures-directional-momentum",
          exchange: "ccxt:coinbaseadvanced",
          mode: this.currentConfig.mode,
          symbol: this.currentConfig.symbol,
          side: this.status.side === "long" ? "sell" : "buy",
          price: currentPrice,
          amount: contracts,
          orderId: (closeResult.order as any)?.id ?? "close",
          positionAction: "close",
        };
        if (profitQuote !== undefined) closeTrade.profitQuote = profitQuote;
        if (netProfitQuote !== undefined) closeTrade.netProfitQuote = netProfitQuote;
        this.currentCtx.emitTrade(closeTrade);
      } catch (e: any) {
        this.setStatus(this.currentCtx, { lastMessage: `stop: close failed: ${e?.message ?? String(e)}` });
      }
    }

    try {
      await this.runningPromise;
    } catch {
      // swallow
    } finally {
      this.runningPromise = null;
      this.status = {
        ...this.status,
        running: false,
        side: "flat",
        lastMessage: "stopped",
      };
      ctx?.onStatus?.(this.status);
    }
  }

  private async fetchPrice(symbol: string): Promise<number> {
    const ex = createPublicCoinbaseAdvanced();
    const ticker = await ex.fetchTicker(symbol);
    const bid = typeof ticker.bid === "number" ? ticker.bid : Number(ticker.bid ?? 0);
    const ask = typeof ticker.ask === "number" ? ticker.ask : Number(ticker.ask ?? 0);
    if (bid > 0 && ask > 0) return (bid + ask) / 2;
    if (typeof ticker.last === "number") return ticker.last;
    if (typeof ticker.close === "number") return ticker.close;
    throw new Error("ticker had no usable price");
  }

  private calculateFeesForClose(
    opts: { contracts: number; cfg: DirectionalConfig },
    entryPrice: number,
    exitPrice: number,
    contractSize: number,
  ): number {
    const contracts = Math.abs(opts.contracts);
    const taker = opts.cfg.takerFeeRate ?? 0.001;
    const perContract = opts.cfg.perContractFeeUsd ?? 0.15;
    const notionalEntry = contracts * contractSize * entryPrice;
    const notionalExit = contracts * contractSize * exitPrice;
    const entryFee = notionalEntry * taker + contracts * perContract;
    const exitFee = notionalExit * taker + contracts * perContract;
    return entryFee + exitFee;
  }

  private async run(
    ctx: Ctx,
    opts: { mode: DirectionalMode; symbol: string; contracts: number; side: "long" | "short"; cfg: DirectionalConfig },
  ) {
    const { symbol, contracts, cfg, side: desiredSide } = opts;
    const pollMs = cfg.pollMs;

    let lastPeak: number | undefined;
    let lastValley: number | undefined;

    while (!this.stopRequested) {
      try {
        const price = await this.fetchPrice(symbol);
        const side = this.status.side;

        // Update lastPeak / lastValley depending on current mode
        if (lastPeak == null) lastPeak = price;
        if (lastValley == null) lastValley = price;
        if (price > lastPeak) lastPeak = price;
        if (price < lastValley) lastValley = price;

        let estimatedGrossPnl: number | undefined;
        let estimatedNetPnl: number | undefined;
        let profitLocked = this.status.profitLocked ?? false;
        let maxProfitAchieved = this.status.maxProfitAchieved;
        let trailingStopPrice: number | undefined;

        const contractSize = this.status.contractSize ?? 1;

        if (side !== "flat" && this.status.entryPrice != null) {
          const contractCount = Math.abs(contracts);
          if (side === "long") {
            estimatedGrossPnl = (price - this.status.entryPrice) * contractCount * contractSize;
          } else {
            estimatedGrossPnl = (this.status.entryPrice - price) * contractCount * contractSize;
          }
          const closeFees = this.calculateFeesForClose({ contracts, cfg }, this.status.entryPrice, price, contractSize);
          estimatedNetPnl = estimatedGrossPnl - closeFees;

          // Profit lock + high-water trailing
          if (cfg.feeGateEnabled && cfg.profitLockThreshold != null && this.status.entryPrice > 0) {
            const entryNotional = contractCount * contractSize * this.status.entryPrice;
            const netPnlPercent = entryNotional > 0 && estimatedNetPnl != null ? estimatedNetPnl / entryNotional : 0;

            if (!profitLocked && netPnlPercent >= cfg.profitLockThreshold) {
              profitLocked = true;
              if (maxProfitAchieved == null) {
                maxProfitAchieved = netPnlPercent;
              }
            }

            if (profitLocked && maxProfitAchieved != null) {
              if (netPnlPercent > maxProfitAchieved) {
                maxProfitAchieved = netPnlPercent;
              }
            } else if (profitLocked && maxProfitAchieved == null) {
              maxProfitAchieved = netPnlPercent;
            }

            const trailingDistance = cfg.trailingDistance ?? cfg.profitLockThreshold ?? 0.01;
            if (profitLocked && maxProfitAchieved != null) {
              const targetProfitPercent = maxProfitAchieved - trailingDistance;
              if (targetProfitPercent > 0) {
                const entryNotionalLocal = entryNotional;
                const taker = cfg.takerFeeRate ?? 0.001;
                const perContract = cfg.perContractFeeUsd ?? 0.15;
                const entryFee = entryNotionalLocal * taker + contractCount * perContract;
                const feeOverNotional = (entryFee + contractCount * perContract) / entryNotionalLocal;

                if (side === "long") {
                  if (1 - taker > 0) {
                    trailingStopPrice =
                      this.status.entryPrice * (1 + targetProfitPercent + feeOverNotional) / (1 - taker);
                  }
                } else if (side === "short") {
                  if (1 + taker > 0) {
                    trailingStopPrice =
                      this.status.entryPrice * (1 - targetProfitPercent - feeOverNotional) / (1 + taker);
                  }
                }
              }
            }
          }
        }

        // Determine next entry price when flat
        let nextEntryPrice: number | undefined;
        if (side === "flat") {
          if (desiredSide === "long") {
            // LONG: track valley, buy when we bounce up by buyDelta
            lastValley = Math.min(lastValley ?? price, price);
            nextEntryPrice = lastValley * (1 + cfg.buyDelta);
          } else {
            // SHORT: track peak, sell when we drop by sellDelta
            lastPeak = Math.max(lastPeak ?? price, price);
            nextEntryPrice = lastPeak * (1 - cfg.sellDelta);
          }
        }

        // Publish status
        this.setStatus(ctx, {
          lastPrice: price,
          lastPeak,
          lastValley,
          ...(nextEntryPrice !== undefined ? { nextEntryPrice } : {}),
          ...(estimatedGrossPnl !== undefined ? { estimatedGrossPnl } : {}),
          ...(estimatedNetPnl !== undefined ? { estimatedNetPnl } : {}),
          ...(profitLocked ? { profitLocked: true } : {}),
          ...(maxProfitAchieved !== undefined ? { maxProfitAchieved } : {}),
          ...(trailingStopPrice !== undefined ? { trailingStopPrice } : {}),
          lastMessage:
            side === "flat"
              ? `waiting for ${desiredSide} entry`
              : profitLocked
                ? `profit locked: ${(maxProfitAchieved ?? 0) * 100}% high-water`
                : `in ${side} position`,
        });

        // Auto-close on trailing stop
        if (side !== "flat" && profitLocked && trailingStopPrice != null) {
          if ((side === "long" && price < trailingStopPrice) || (side === "short" && price > trailingStopPrice)) {
            this.setStatus(ctx, {
              lastMessage: `trailing stop hit: closing ${side.toUpperCase()} to FLAT at ${price.toFixed(2)}`,
            });
            await this.closeToFlat(ctx, { mode: opts.mode, symbol, contracts, cfg });
            lastPeak = price;
            lastValley = price;
          }
        }

        // Entry logic when flat
        if (side === "flat") {
          if (desiredSide === "long" && nextEntryPrice != null && price >= nextEntryPrice) {
            await this.open(ctx, { mode: opts.mode, symbol, contracts, side: "long", cfg });
            lastPeak = price;
            lastValley = price;
          } else if (desiredSide === "short" && nextEntryPrice != null && price <= nextEntryPrice) {
            await this.open(ctx, { mode: opts.mode, symbol, contracts, side: "short", cfg });
            lastPeak = price;
            lastValley = price;
          }
        }
      } catch (e: any) {
        this.setStatus(ctx, { lastMessage: `loop error: ${e?.message ?? String(e)}` });
      }

      await sleep(pollMs);
    }
  }

  private async open(
    ctx: Ctx,
    opts: { mode: DirectionalMode; symbol: string; contracts: number; side: "long" | "short"; cfg: DirectionalConfig },
  ) {
    const { mode, symbol, contracts, side, cfg } = opts;
    const contractCount = Math.abs(contracts);
    const contractSize = this.status.contractSize ?? 1;
    const currentPrice = this.status.lastPrice ?? (await this.fetchPrice(symbol));

    const tradeMode: "paper" | "live" = mode === "live" ? "live" : "paper";

    if (mode === "live") {
      const req: FuturesOrderRequest = {
        symbol,
        contracts: contractCount,
        side: side === "long" ? "buy" : "sell",
        type: "market" as const,
        ...(cfg.retail_portfolio_id ? { retail_portfolio_id: cfg.retail_portfolio_id } : {}),
      };
      const placed = await placeFuturesOrder({ apiKey: ctx.apiKey, secret: ctx.secret, req });
      ctx.emitTrade({
        ts: new Date().toISOString(),
        strategy: "futures-directional-momentum",
        exchange: "ccxt:coinbaseadvanced",
        mode: tradeMode,
        symbol,
        side: side === "long" ? "buy" : "sell",
        price: currentPrice,
        amount: contractCount,
        orderId: (placed.order as any)?.id ?? "open",
        positionAction: "open",
      });
    } else {
      // preview: just emit a synthetic open trade
      ctx.emitTrade({
        ts: new Date().toISOString(),
        strategy: "futures-directional-momentum",
        exchange: "ccxt:coinbaseadvanced",
        mode: tradeMode,
        symbol,
        side: side === "long" ? "buy" : "sell",
        price: currentPrice,
        amount: contractCount,
        orderId: "preview-open",
        positionAction: "open",
      });
    }

    // Reset profit-lock / PnL state on new position
    // Clear old optional fields explicitly
    if ("maxProfitAchieved" in this.status) {
      delete (this.status as any).maxProfitAchieved;
    }
    if ("trailingStopPrice" in this.status) {
      delete (this.status as any).trailingStopPrice;
    }
    if ("estimatedGrossPnl" in this.status) {
      delete (this.status as any).estimatedGrossPnl;
    }
    if ("estimatedNetPnl" in this.status) {
      delete (this.status as any).estimatedNetPnl;
    }
    this.setStatus(ctx, {
      side,
      entryPrice: currentPrice,
      profitLocked: false,
      lastMessage: `opened ${side} at ${currentPrice.toFixed(2)} (contracts=${contractCount}, size=${contractSize})`,
    });
  }

  private async closeToFlat(
    ctx: Ctx,
    opts: { mode: DirectionalMode; symbol: string; contracts: number; cfg: DirectionalConfig },
  ) {
    const currentSide = this.status.side;
    if (currentSide === "flat") return;

    const currentPrice = this.status.lastPrice ?? (await this.fetchPrice(opts.symbol));
    const entryPrice = this.status.entryPrice;
    const contractSize = this.status.contractSize ?? 1;
    const contracts = Math.abs(opts.contracts);
    let profitQuote: number | undefined;
    let netProfitQuote: number | undefined;

    if (entryPrice != null) {
      if (currentSide === "long") {
        profitQuote = (currentPrice - entryPrice) * contracts * contractSize;
      } else {
        profitQuote = (entryPrice - currentPrice) * contracts * contractSize;
      }
      const closeFees = this.calculateFeesForClose({ contracts, cfg: opts.cfg }, entryPrice, currentPrice, contractSize);
      netProfitQuote = profitQuote - closeFees;
    }

    if (opts.mode === "live") {
      const closeResult = await closeFuturesPosition({
        apiKey: ctx.apiKey,
        secret: ctx.secret,
        symbol: opts.symbol,
      });
      const closeTrade: any = {
        ts: new Date().toISOString(),
        strategy: "futures-directional-momentum",
        exchange: "ccxt:coinbaseadvanced",
        mode: opts.mode,
        symbol: opts.symbol,
        side: currentSide === "long" ? "sell" : "buy",
        price: currentPrice,
        amount: contracts,
        orderId: (closeResult.order as any)?.id ?? "close",
        positionAction: "close",
      };
      if (profitQuote !== undefined) closeTrade.profitQuote = profitQuote;
      if (netProfitQuote !== undefined) closeTrade.netProfitQuote = netProfitQuote;
      ctx.emitTrade(closeTrade);
    } else {
      const previewCloseTrade: any = {
        ts: new Date().toISOString(),
        strategy: "futures-directional-momentum",
        exchange: "ccxt:coinbaseadvanced",
        mode: "paper",
        symbol: opts.symbol,
        side: currentSide === "long" ? "sell" : "buy",
        price: currentPrice,
        amount: contracts,
        orderId: "preview-close",
        positionAction: "close",
      };
      if (profitQuote !== undefined) previewCloseTrade.profitQuote = profitQuote;
      if (netProfitQuote !== undefined) previewCloseTrade.netProfitQuote = netProfitQuote;
      ctx.emitTrade(previewCloseTrade);
    }

    // Reset to flat state
    // Clear optional fields explicitly to avoid exactOptionalPropertyTypes issues
    if ("entryPrice" in this.status) {
      delete (this.status as any).entryPrice;
    }
    if ("maxProfitAchieved" in this.status) {
      delete (this.status as any).maxProfitAchieved;
    }
    if ("trailingStopPrice" in this.status) {
      delete (this.status as any).trailingStopPrice;
    }
    if ("estimatedGrossPnl" in this.status) {
      delete (this.status as any).estimatedGrossPnl;
    }
    if ("estimatedNetPnl" in this.status) {
      delete (this.status as any).estimatedNetPnl;
    }
    this.setStatus(ctx, {
      side: "flat",
      profitLocked: false,
      lastMessage: `closed ${currentSide} to FLAT at ${currentPrice.toFixed(2)}`,
    });
  }
}


