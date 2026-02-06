import ccxt from "ccxt";
import { sleep } from "../util/sleep";
import type { TradeEvent } from "../events/trades";
import { closeFuturesPosition, getFuturesMarket, previewFuturesOrder, placeFuturesOrder } from "./cfmFutures";

/**
 * Check if current time is within intraday window (8am-4pm ET) for 10x leverage, or outside (4x leverage).
 * Returns the leverage multiplier.
 */
/**
 * Get current leverage based on ET time: 8am-4pm ET = 10x, otherwise 4x.
 * Uses UTC time approximation: 8am-4pm ET ≈ 13:00-21:00 UTC (EST) or 12:00-20:00 UTC (EDT).
 * This is approximate but works for most of the year.
 */
function getCurrentLeverage(): number {
  const now = new Date();
  const utcHour = now.getUTCHours();
  
  // 8am-4pm ET:
  // - EST (UTC-5): 8am ET = 13:00 UTC, 4pm ET = 21:00 UTC
  // - EDT (UTC-4): 8am ET = 12:00 UTC, 4pm ET = 20:00 UTC
  // Use 12:00-21:00 UTC to cover both (slightly wider window, but safer)
  if (utcHour >= 12 && utcHour < 21) {
    return 10; // Intraday: 8am-4pm ET
  }
  return 4; // Overnight: outside 8am-4pm ET
}

export type FlipMode = "preview" | "live";

export type FlipStatus = {
  running: boolean;
  mode: FlipMode | null;
  symbol: string | null;
  contracts: number | null;
  side: "flat" | "long" | "short";
  lastPrice: number | null;
  lastMessage: string | null;
  entryPrice?: number;
  contractSize?: number;
  estimatedFlipFees?: number;
  estimatedGrossPnl?: number;
  estimatedNetPnl?: number; // net profit (gross - fees) for current position
  profitLocked?: boolean; // true when profit lock is active (1%+ NET profitable in profit-bound mode)
  profitLockTarget?: number; // price that preserves NET profit lock threshold (calculated to account for fees)
  maxProfitAchieved?: number; // highest net profit % achieved (high-water mark for trailing stop)
  trailingStopPrice?: number; // current trailing stop price (maxProfitAchieved - trailingDistance)
  leverage?: number; // current leverage (10x intraday 8am-4pm ET, 4x overnight)
  requiredMargin?: number; // required margin for current position (contracts * contractSize * price / leverage)
  // For UI visibility
  lastPeak?: number;
  lastValley?: number;
  nextFlipToShort?: number; // from peak
  nextFlipToLong?: number; // from valley
  nextEntryToShort?: number; // from peak (only used when flat)
  nextEntryToLong?: number; // from valley (only used when flat)
};

export type FlipConfig = {
  buyDelta: number; // used for short->long flip trigger (bounce up from valley)
  sellDelta: number; // used for long->short flip trigger (drop from peak)
  entryShortDelta?: number; // used only for flat->short entry; defaults to sellDelta
  pollMs: number;
  retail_portfolio_id?: string;
  // Fee gating:
  feeGateEnabled?: boolean; // when false, flips always allowed; when true, apply profit > fees * multiple rule
  takerFeeRate?: number; // e.g. 0.001 for 0.10%
  makerFeeRate?: number; // e.g. 0.00095 for 0.095%
  perContractFeeUsd?: number; // e.g. 0.15
  minProfitMultiple?: number; // e.g. 1.5
  profitLockThreshold?: number; // e.g. 0.01 = 1%; once profitable by this %, lock flip thresholds to preserve profit
  trailingDistance?: number; // e.g. 0.01 = 1%; trailing stop distance below high-water mark (default: same as profitLockThreshold)
};

type Ctx = {
  apiKey: string;
  secret: string;
  emitTrade: (t: TradeEvent) => void;
  onStatus?: (s: FlipStatus) => void;
};

function createPublicCoinbaseAdvanced() {
  const ExchangeCtor = (ccxt as any)["coinbaseadvanced"] ?? (ccxt as any)["coinbase"];
  return new ExchangeCtor({ enableRateLimit: true, timeout: 30_000 });
}

export class FuturesFlipMomentumRunner {
  private stopRequested = false;
  private runningPromise: Promise<void> | null = null;
  private currentCtx: Ctx | null = null; // Store context for stop() to close positions
  private currentConfig: { mode: FlipMode; symbol: string; contracts: number; cfg: FlipConfig } | null = null; // Store config for stop()

  private status: FlipStatus = {
    running: false,
    mode: null,
    symbol: null,
    contracts: null,
    side: "flat",
    lastPrice: null,
    lastMessage: null,
  };

  getStatus() {
    return this.status;
  }

  async start(ctx: Ctx, opts: { mode: FlipMode; symbol: string; contracts: number; cfg: FlipConfig }) {
    if (this.status.running) throw new Error("Flip strategy already running");
    this.stopRequested = false;
    this.currentCtx = ctx; // Store context for stop()
    this.currentConfig = opts; // Store config for stop()

    this.status = {
      running: true,
      mode: opts.mode,
      symbol: opts.symbol,
      contracts: opts.contracts,
      side: "flat",
      lastPrice: null,
      lastMessage: `starting futures flip momentum on ${opts.symbol} (${opts.mode})`,
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
      // non-fatal; price loop can still run
      this.status = { ...this.status, lastMessage: `warning: failed to load market (contractSize unknown): ${e?.message ?? String(e)}` };
      ctx.onStatus?.(this.status);
    }

    // IMPORTANT: don't re-throw here. If the background loop throws and nobody awaits this promise,
    // Node can treat it as an unhandled rejection and crash the process (nodemon restarts).
    this.runningPromise = this.run(ctx, opts).catch((e) => {
      this.status = { ...this.status, running: false, lastMessage: `error: ${e?.message ?? String(e)}` };
      ctx.onStatus?.(this.status);
    });
  }

  async stop(ctx?: { onStatus?: (s: FlipStatus) => void }) {
    this.stopRequested = true;
    
    // Close any open position before stopping
    if (this.status.side !== "flat" && this.currentCtx && this.currentConfig) {
      try {
        // Fetch fresh price if lastPrice is null
        let currentPrice = this.status.lastPrice ?? 0;
        if (currentPrice === 0 && this.currentConfig.symbol) {
          try {
            currentPrice = await this.fetchPrice(this.currentConfig.symbol);
          } catch (e: any) {
            // If price fetch fails, use 0 and continue (market order will execute at current price anyway)
            this.setStatus(this.currentCtx, { 
              lastMessage: `stop: warning - could not fetch current price: ${e?.message ?? String(e)}` 
            });
          }
        }
        
        const entryPrice = this.status.entryPrice;
        const contractSize = this.status.contractSize ?? 1;
        const contracts = Math.abs(this.currentConfig.contracts);
        let profitQuote: number | undefined;

        // Calculate profit
        const stopSide = this.status.side; // Capture side before closing
        let netProfitQuote: number | undefined;
        if (entryPrice != null && currentPrice > 0) {
          if (stopSide === "long") {
            profitQuote = (currentPrice - entryPrice) * contracts * contractSize;
          } else {
            profitQuote = (entryPrice - currentPrice) * contracts * contractSize;
          }
          
          // Calculate net profit (gross - fees)
          const closeFees = this.calculateFeesForClose(this.currentConfig, entryPrice, currentPrice, contractSize);
          netProfitQuote = profitQuote - closeFees;
        }

        // Close position
        if (this.currentConfig.mode === "live") {
          // Live mode: actually close the position
          const closeResult = await closeFuturesPosition({
            apiKey: this.currentCtx.apiKey,
            secret: this.currentCtx.secret,
            symbol: this.currentConfig.symbol,
          });
          
          // Emit close trade event
          const closeTrade: any = {
            ts: new Date().toISOString(),
            strategy: "futures-flip-momentum",
            exchange: "ccxt:coinbaseadvanced",
            mode: "live",
            symbol: this.currentConfig.symbol,
            side: stopSide === "long" ? "sell" : "buy", // opposite of position side
            price: currentPrice,
            amount: contracts,
            orderId: (closeResult.order as any)?.id ?? "close",
            positionAction: "close",
          };
          if (profitQuote !== undefined) closeTrade.profitQuote = profitQuote;
          if (netProfitQuote !== undefined) closeTrade.netProfitQuote = netProfitQuote;
          this.currentCtx.emitTrade(closeTrade);
          
          // Reset position state (omit entryPrice to clear it)
          if ("entryPrice" in this.status) {
            delete (this.status as any).entryPrice;
          }
          this.setStatus(this.currentCtx, { 
            side: "flat",
            lastMessage: `position closed on stop (live mode)` 
          });
        } else {
          // Preview mode: emit a close event for UI visibility
          const previewCloseTrade: any = {
            ts: new Date().toISOString(),
            strategy: "futures-flip-momentum",
            exchange: "ccxt:coinbaseadvanced",
            mode: "paper",
            symbol: this.currentConfig.symbol,
            side: stopSide === "long" ? "sell" : "buy",
            price: currentPrice,
            amount: contracts,
            orderId: "preview-close-stop",
            positionAction: "close",
          };
          if (profitQuote !== undefined) previewCloseTrade.profitQuote = profitQuote;
          if (netProfitQuote !== undefined) previewCloseTrade.netProfitQuote = netProfitQuote;
          this.currentCtx.emitTrade(previewCloseTrade);
          
          // Reset position state (omit entryPrice to clear it)
          if ("entryPrice" in this.status) {
            delete (this.status as any).entryPrice;
          }
          this.setStatus(this.currentCtx, { 
            side: "flat",
            lastMessage: `position closed on stop (preview mode)` 
          });
        }
      } catch (e: any) {
        // Log error but continue with stop
        this.setStatus(this.currentCtx, { 
          lastMessage: `stop: failed to close position: ${e?.message ?? String(e)}` 
        });
      }
    }
    
    try {
      await this.runningPromise;
    } catch {
      // swallow
    } finally {
      this.runningPromise = null;
      this.currentCtx = null; // Clear stored context
      this.currentConfig = null; // Clear stored config
      this.status = { ...this.status, running: false, lastMessage: "stopped" };
      ctx?.onStatus?.(this.status);
    }
  }

  private setStatus(ctx: Ctx, patch: Partial<FlipStatus>) {
    this.status = { ...this.status, ...patch };
    ctx.onStatus?.(this.status);
  }

  private async fetchPrice(symbol: string): Promise<number> {
    const ex = createPublicCoinbaseAdvanced();
    try {
      const t = await ex.fetchTicker(symbol);
      const mid =
        (typeof t.bid === "number" && typeof t.ask === "number" && t.bid > 0 && t.ask > 0)
          ? (t.bid + t.ask) / 2
          : typeof t.last === "number"
            ? t.last
            : null;
      if (mid == null || !Number.isFinite(mid)) throw new Error(`Failed to fetch price for ${symbol}`);
      return mid;
    } finally {
      try {
        await ex.close?.();
      } catch {
        // ignore
      }
    }
  }

  private async run(ctx: Ctx, opts: { mode: FlipMode; symbol: string; contracts: number; cfg: FlipConfig }) {
    const { mode, symbol, contracts, cfg } = opts;

    // Initialize from status if available (persists across iterations), otherwise start at 0
    let lastPeak = this.status.lastPeak ?? 0;
    let lastValley = this.status.lastValley ?? 0;

    // seed
    while (!this.stopRequested && this.status.lastPrice == null) {
      try {
        const p = await this.fetchPrice(symbol);
        lastPeak = p;
        lastValley = p;
        this.setStatus(ctx, {
          lastPrice: p,
          lastPeak,
          lastValley,
          nextFlipToShort: lastPeak * (1 - cfg.sellDelta),
          nextFlipToLong: lastValley * (1 + cfg.buyDelta),
          lastMessage: "seeded price",
        });
      } catch (e: any) {
        this.setStatus(ctx, { lastMessage: `waiting for price: ${e?.message ?? String(e)}` });
        await sleep(1000);
      }
    }

    // start long by default? We'll stay flat until first trigger. (Safer)
    while (!this.stopRequested) {
      let price: number;
      try {
        price = await this.fetchPrice(symbol);
      } catch (e: any) {
        this.setStatus(ctx, { lastMessage: `price fetch error: ${e?.message ?? String(e)}` });
        await sleep(Math.min(cfg.pollMs * 2, 5000));
        continue;
      }

      // Update anchors based on current side
      if (this.status.side === "long") {
        if (price > lastPeak) {
          lastPeak = price;
          lastValley = price;
        } else if (price < lastValley) {
          lastValley = price;
        }
      } else if (this.status.side === "short") {
        if (price < lastValley) {
          lastValley = price;
          lastPeak = price;
        } else if (price > lastPeak) {
          lastPeak = price;
        }
      } else {
        // flat: track valley/peak loosely
        if (price < lastValley) lastValley = price;
        if (price > lastPeak) lastPeak = price;
      }

      // Compute dynamic gross and net PnL for open positions
      let estimatedGrossPnl: number | undefined;
      let estimatedNetPnl: number | undefined;
      // Profit lock persists once activated - it stays locked until position closes
      let profitLocked = this.status.profitLocked ?? false;
      // High-water mark trailing stop: track max profit achieved and trail stop below it
      let maxProfitAchieved = this.status.maxProfitAchieved;
      if (this.status.side !== "flat" && this.status.entryPrice != null && this.status.contractSize != null) {
        const contractCount = Math.abs(contracts);
        if (this.status.side === "long") {
          estimatedGrossPnl = (price - this.status.entryPrice) * contractCount * this.status.contractSize;
        } else {
          estimatedGrossPnl = (this.status.entryPrice - price) * contractCount * this.status.contractSize;
        }
        
        // Calculate net profit (gross - fees)
        const closeFees = this.calculateFeesForClose({ contracts, cfg }, this.status.entryPrice, price, this.status.contractSize);
        estimatedNetPnl = estimatedGrossPnl - closeFees;

        // Profit lock: if we're NET profitable by threshold% AND in profit-bound mode, activate lock (persists until close)
        // We use NET profit percentage, not gross, because we only care about actual profit after fees
        if (cfg.feeGateEnabled && cfg.profitLockThreshold != null && this.status.entryPrice > 0) {
          // Net profit percentage = (net profit / entry notional)
          const entryNotional = contractCount * this.status.contractSize * this.status.entryPrice;
          const netPnlPercent = entryNotional > 0 ? estimatedNetPnl / entryNotional : 0;

          // Once profit lock is activated, it stays locked (don't reset it)
          if (!profitLocked && netPnlPercent >= cfg.profitLockThreshold) {
            profitLocked = true;
            // Initialize high-water mark when lock first activates
            if (maxProfitAchieved == null) {
              maxProfitAchieved = netPnlPercent;
            }
          }

          // Update high-water mark: only move up, never down
          if (profitLocked && maxProfitAchieved != null) {
            if (netPnlPercent > maxProfitAchieved) {
              maxProfitAchieved = netPnlPercent;
            }
          } else if (profitLocked && maxProfitAchieved == null) {
            // Shouldn't happen, but safety check
            maxProfitAchieved = netPnlPercent;
          }
        }
      }

      // Calculate base flip thresholds
      let flipToShortAt = lastPeak * (1 - cfg.sellDelta);
      let flipToLongAt = lastValley * (1 + cfg.buyDelta);

      // Apply profit lock with high-water mark trailing stop
      // Trailing stop trails upward as profit increases, but never moves down
      let trailingStopPrice: number | undefined;
      const trailingDistance = cfg.trailingDistance ?? cfg.profitLockThreshold ?? 0.01; // default 1%
      
      if (profitLocked && maxProfitAchieved != null && this.status.entryPrice != null && this.status.contractSize != null) {
        const contractCount = Math.abs(contracts);
        const entryNotional = contractCount * this.status.contractSize * this.status.entryPrice;
        const taker = cfg.takerFeeRate ?? 0.001;
        const perContract = cfg.perContractFeeUsd ?? 0.15;
        const entryFee = entryNotional * taker + contractCount * perContract;
        
        // Calculate the target profit % (high-water mark - trailing distance)
        const targetProfitPercent = maxProfitAchieved - trailingDistance;
        
        if (this.status.side === "long") {
          // LONG: Calculate price that gives us targetProfitPercent% NET profit
          // net profit = (price - entry) * contracts * contractSize - entryFee - exitFee
          // exitFee = price * contracts * contractSize * taker + contracts * perContract
          // We want: net profit / entryNotional = targetProfitPercent
          // Solving: price = entry * (1 + targetProfitPercent + (entryFee + contracts * perContract) / entryNotional) / (1 - taker)
          const feeOverNotional = (entryFee + contractCount * perContract) / entryNotional;
          if (1 - taker > 0 && targetProfitPercent > 0) {
            trailingStopPrice = this.status.entryPrice * (1 + targetProfitPercent + feeOverNotional) / (1 - taker);
          } else {
            // Fallback: use entry price if calculation fails
            trailingStopPrice = this.status.entryPrice;
          }
          // FORCE flip-to-short to trailing stop price (trails upward, never down)
          flipToShortAt = trailingStopPrice;
        } else if (this.status.side === "short") {
          // SHORT: Calculate price that gives us targetProfitPercent% NET profit
          // net profit = (entry - price) * contracts * contractSize - entryFee - exitFee
          // exitFee = price * contracts * contractSize * taker + contracts * perContract
          // We want: net profit / entryNotional = targetProfitPercent
          // Solving: price = entry * (1 - targetProfitPercent - (entryFee + contracts * perContract) / entryNotional) / (1 + taker)
          const feeOverNotional = (entryFee + contractCount * perContract) / entryNotional;
          if (1 + taker > 0 && targetProfitPercent > 0) {
            trailingStopPrice = this.status.entryPrice * (1 - targetProfitPercent - feeOverNotional) / (1 + taker);
          } else {
            // Fallback: use entry price if calculation fails
            trailingStopPrice = this.status.entryPrice;
          }
          // FORCE flip-to-long to trailing stop price (trails upward, never down)
          flipToLongAt = trailingStopPrice;
        }
      }

      const entryShortDelta = cfg.entryShortDelta ?? cfg.sellDelta;
      const entryToShortAt = lastPeak * (1 - entryShortDelta);
      const entryToLongAt = lastValley * (1 + cfg.buyDelta);

      // Calculate current leverage and required margin
      const leverage = getCurrentLeverage();
      let requiredMargin: number | undefined;
      if (this.status.contracts != null && this.status.contractSize != null && price > 0) {
        // Required margin = (contracts * contractSize * price) / leverage
        const notional = contracts * this.status.contractSize * price;
        requiredMargin = notional / leverage;
      }

      this.setStatus(ctx, {
        lastPrice: price,
        lastPeak,
        lastValley,
        nextFlipToShort: flipToShortAt,
        nextFlipToLong: flipToLongAt,
        ...(this.status.side === "flat" ? { nextEntryToShort: entryToShortAt, nextEntryToLong: entryToLongAt } : {}),
        ...(estimatedGrossPnl !== undefined ? { estimatedGrossPnl } : {}),
        ...(estimatedNetPnl !== undefined ? { estimatedNetPnl } : {}),
        ...(profitLocked ? { profitLocked: true } : {}),
        ...(maxProfitAchieved !== undefined ? { maxProfitAchieved } : {}),
        ...(trailingStopPrice !== undefined ? { trailingStopPrice } : {}),
        leverage,
        ...(requiredMargin !== undefined ? { requiredMargin } : {}),
        lastMessage:
          profitLocked && maxProfitAchieved != null
            ? `profit locked: ${(maxProfitAchieved * 100).toFixed(2)}% high-water mark (trailing stop: ${((maxProfitAchieved - trailingDistance) * 100).toFixed(2)}%)`
            : profitLocked
            ? `profit locked (flip threshold adjusted to preserve ${((cfg.profitLockThreshold ?? 0.01) * 100).toFixed(1)}%+ NET profit)`
            : this.status.side === "long"
              ? "tracking peak (long)"
              : this.status.side === "short"
                ? "tracking valley (short)"
                : "flat; waiting for first entry",
      });

      // Decide actions
      let alreadyFlipped = false;
      
      // Priority 1: If profit is locked and price violates the trailing stop, close to FLAT immediately
      if (profitLocked && trailingStopPrice != null) {
        if (this.status.side === "long" && price < trailingStopPrice) {
          this.setStatus(ctx, {
            lastMessage: `trailing stop hit: closing LONG to FLAT (price ${price.toFixed(2)} < trailing stop ${trailingStopPrice.toFixed(2)})`,
          });
          await this.closeToFlat(ctx, { mode, symbol, contracts, cfg });
          lastPeak = price;
          lastValley = price;
          alreadyFlipped = true;
        } else if (this.status.side === "short" && price > trailingStopPrice) {
          this.setStatus(ctx, {
            lastMessage: `trailing stop hit: closing SHORT to FLAT (price ${price.toFixed(2)} > trailing stop ${trailingStopPrice.toFixed(2)})`,
          });
          await this.closeToFlat(ctx, { mode, symbol, contracts, cfg });
          lastPeak = price;
          lastValley = price;
          alreadyFlipped = true;
        }
      }
      
      // Priority 2: Normal flip signals (only if profit lock wasn't violated)
      if (!alreadyFlipped && this.status.side === "long" && price <= flipToShortAt) {
        this.setStatus(ctx, { lastMessage: `flip signal: LONG -> SHORT (price ${price.toFixed(2)} <= ${flipToShortAt.toFixed(2)})` });
        await this.flip(ctx, { mode, symbol, contracts, cfg }, "short");
        lastPeak = price;
        lastValley = price;
        alreadyFlipped = true; // Prevent duplicate flips in same iteration
      } else if (!alreadyFlipped && this.status.side === "short" && price >= flipToLongAt) {
        this.setStatus(ctx, { lastMessage: `flip signal: SHORT -> LONG (price ${price.toFixed(2)} >= ${flipToLongAt.toFixed(2)})` });
        await this.flip(ctx, { mode, symbol, contracts, cfg }, "long");
        lastPeak = price;
        lastValley = price;
        alreadyFlipped = true; // Prevent duplicate flips in same iteration
      } else if (this.status.side === "flat") {
        // First entry rules: enter long on bounce up, enter short on breakdown
        const enterLongAt = lastValley * (1 + cfg.buyDelta);
        const enterShortAt = lastPeak * (1 - (cfg.entryShortDelta ?? cfg.sellDelta));
        if (price >= enterLongAt) {
          this.setStatus(ctx, { lastMessage: `entry signal: FLAT -> LONG (price ${price.toFixed(2)} >= ${enterLongAt.toFixed(2)})` });
          await this.open(ctx, { mode, symbol, contracts, cfg }, "long");
          lastPeak = price;
          lastValley = price;
        } else if (price <= enterShortAt) {
          this.setStatus(ctx, { lastMessage: `entry signal: FLAT -> SHORT (price ${price.toFixed(2)} <= ${enterShortAt.toFixed(2)})` });
          await this.open(ctx, { mode, symbol, contracts, cfg }, "short");
          lastPeak = price;
          lastValley = price;
        }
      }

      await sleep(cfg.pollMs);
    }
  }

  private async open(ctx: Ctx, opts: { mode: FlipMode; symbol: string; contracts: number; cfg: FlipConfig }, side: "long" | "short") {
    const req = {
      symbol: opts.symbol,
      type: "market" as const,
      side: side === "long" ? ("buy" as const) : ("sell" as const),
      contracts: opts.contracts,
      ...(opts.cfg.retail_portfolio_id ? { retail_portfolio_id: opts.cfg.retail_portfolio_id } : {}),
    };

    if (opts.mode === "preview") {
      const result = await previewFuturesOrder({ apiKey: ctx.apiKey, secret: ctx.secret, req });
      let parsed: any | null = null;
      if (typeof result.lastHttpResponse === "string") {
        try {
          parsed = JSON.parse(result.lastHttpResponse);
        } catch {
          parsed = null;
        }
      }
      const errs: string[] = Array.isArray(parsed?.errs) ? parsed.errs : [];
      // In preview mode, allow "insufficient funds" errors to pass (it's just a preview, not a real trade)
      // Filter out insufficient funds errors for preview mode
      const nonFundsErrors = errs.filter((e: string) => !e.includes("INSUFFICIENT_FUNDS"));
      if (nonFundsErrors.length > 0) {
        this.setStatus(ctx, { lastMessage: `preview rejected: ${nonFundsErrors.join(", ")}` });
        return;
      }
      // If only insufficient funds errors, log a warning but proceed (preview mode)
      if (errs.length > 0) {
        this.setStatus(ctx, {
          lastMessage: `preview: insufficient funds in CFM account (preview mode - simulating trade anyway). Transfer funds to CFM for live trading.`,
        });
      }
      ctx.emitTrade({
        ts: new Date().toISOString(),
        strategy: "futures-flip-momentum",
        exchange: "ccxt:coinbaseadvanced",
        mode: "paper",
        symbol: opts.symbol,
        side: req.side,
        price: this.status.lastPrice ?? 0,
        amount: opts.contracts,
        orderId: parsed?.preview_id ?? "preview",
        positionAction: "open",
      });
      // Reset profit lock state when opening new position
      const newStatus: Partial<FlipStatus> = {
        side,
        ...(this.status.lastPrice != null ? { entryPrice: this.status.lastPrice } : {}),
        profitLocked: false,
        lastMessage: `preview ok: opened ${side}`,
      };
      // Explicitly delete profitLockTarget to reset it
      if ("profitLockTarget" in this.status) {
        delete (this.status as any).profitLockTarget;
      }
      this.setStatus(ctx, newStatus);
      return;
    }

    const placed = await placeFuturesOrder({ apiKey: ctx.apiKey, secret: ctx.secret, req });
    ctx.emitTrade({
      ts: new Date().toISOString(),
      strategy: "futures-flip-momentum",
      exchange: "ccxt:coinbaseadvanced",
      mode: "live",
      symbol: opts.symbol,
      side: req.side,
      price: this.status.lastPrice ?? 0,
      amount: opts.contracts,
      orderId: (placed.order as any)?.id ?? "order",
      positionAction: "open",
    });
    // Reset profit lock state when opening new position
    const newStatus: Partial<FlipStatus> = {
      side,
      ...(this.status.lastPrice != null ? { entryPrice: this.status.lastPrice } : {}),
      profitLocked: false,
      lastMessage: `opened ${side}`,
    };
    // Reset high-water mark and trailing stop when opening new position
    if ("maxProfitAchieved" in this.status) {
      delete (this.status as any).maxProfitAchieved;
    }
    if ("trailingStopPrice" in this.status) {
      delete (this.status as any).trailingStopPrice;
    }
    if ("profitLockTarget" in this.status) {
      delete (this.status as any).profitLockTarget;
    }
    this.setStatus(ctx, newStatus);
  }

  private async closeToFlat(ctx: Ctx, opts: { mode: FlipMode; symbol: string; contracts: number; cfg: FlipConfig }) {
    // Guard: prevent multiple closes if we're already flat
    const currentSide = this.status.side;
    if (currentSide === "flat") {
      return;
    }
    
    // Immediately update status to prevent duplicate closes
    this.setStatus(ctx, { side: "flat" }); // Temporarily set to flat to prevent re-triggering
    
    // Close current position and go to FLAT (don't open opposite position)
    const currentPrice = this.status.lastPrice ?? 0;
    const entryPrice = this.status.entryPrice;
    const contractSize = this.status.contractSize ?? 1;
    const contracts = Math.abs(opts.contracts);
    let profitQuote: number | undefined;

    let netProfitQuote: number | undefined;
    // Use currentSide (captured before we set status to flat) for profit calculation
    if (entryPrice != null && (currentSide === "long" || currentSide === "short")) {
      if (currentSide === "long") {
        profitQuote = (currentPrice - entryPrice) * contracts * contractSize;
      } else {
        profitQuote = (entryPrice - currentPrice) * contracts * contractSize;
      }
      
      // Calculate net profit (gross - fees)
      const closeFees = this.calculateFeesForClose(opts, entryPrice, currentPrice, contractSize);
      netProfitQuote = profitQuote - closeFees;
    }

    // Close position
    if (opts.mode === "live") {
      try {
        const closeResult = await closeFuturesPosition({
          apiKey: ctx.apiKey,
          secret: ctx.secret,
          symbol: opts.symbol,
        });
        // Emit close trade event
        const closeTrade: any = {
          ts: new Date().toISOString(),
          strategy: "futures-flip-momentum",
          exchange: "ccxt:coinbaseadvanced",
          mode: "live",
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
      } catch (e: any) {
        this.setStatus(ctx, { lastMessage: `close to flat failed: ${e?.message ?? String(e)}` });
        return;
      }
    } else {
      // Preview mode: emit a close event
      const previewCloseTrade: any = {
        ts: new Date().toISOString(),
        strategy: "futures-flip-momentum",
        exchange: "ccxt:coinbaseadvanced",
        mode: "paper",
        symbol: opts.symbol,
        side: currentSide === "long" ? "sell" : "buy",
        price: currentPrice,
        amount: contracts,
        orderId: "preview-close-flat",
        positionAction: "close",
      };
      if (profitQuote !== undefined) previewCloseTrade.profitQuote = profitQuote;
      if (netProfitQuote !== undefined) previewCloseTrade.netProfitQuote = netProfitQuote;
      ctx.emitTrade(previewCloseTrade);
    }

    // Reset to flat state
    if ("entryPrice" in this.status) {
      delete (this.status as any).entryPrice;
    }
    if ("maxProfitAchieved" in this.status) {
      delete (this.status as any).maxProfitAchieved;
    }
    if ("trailingStopPrice" in this.status) {
      delete (this.status as any).trailingStopPrice;
    }
    if ("profitLockTarget" in this.status) {
      delete (this.status as any).profitLockTarget;
    }
    this.setStatus(ctx, {
      side: "flat",
      profitLocked: false,
      lastMessage: `closed to FLAT (profit preserved)`,
    });
  }

  private calculateFeesForClose(opts: { contracts: number; cfg: FlipConfig }, entryPrice: number, exitPrice: number, contractSize: number): number {
    // Calculate fees for closing a position (entry fee + exit fee)
    const contracts = Math.abs(opts.contracts);
    const taker = opts.cfg.takerFeeRate ?? 0.001;
    const perContract = opts.cfg.perContractFeeUsd ?? 0.15;
    
    const entryNotional = contracts * contractSize * entryPrice;
    const exitNotional = contracts * contractSize * exitPrice;
    const entryFee = entryNotional * taker + contracts * perContract;
    const exitFee = exitNotional * taker + contracts * perContract;
    
    return entryFee + exitFee;
  }

  private async flip(ctx: Ctx, opts: { mode: FlipMode; symbol: string; contracts: number; cfg: FlipConfig }, next: "long" | "short") {
    // Guard: prevent multiple flips if we're already flat (shouldn't happen, but safety check)
    const currentSide = this.status.side;
    if (currentSide === "flat") {
      return;
    }
    
    // Fee gate: only flip if estimated gross PnL from closing the current leg clears (fees * multiple).
    // This is conservative because it includes fees for BOTH close+open legs, but counts only close PnL.
    const gateOk = this.checkFeeGateForFlip(ctx, opts);
    if (!gateOk) return;
    
    // Immediately update status to prevent duplicate flips
    this.setStatus(ctx, { side: "flat" }); // Temporarily set to flat to prevent re-triggering

    // Calculate profit from closing the current position
    const currentPrice = this.status.lastPrice ?? 0;
    const entryPrice = this.status.entryPrice;
    const contractSize = this.status.contractSize ?? 1;
    const contracts = Math.abs(opts.contracts);
    let profitQuote: number | undefined;
    let netProfitQuote: number | undefined;

    // Use currentSide (captured before we set status to flat) for profit calculation
    if (entryPrice != null && (currentSide === "long" || currentSide === "short")) {
      if (currentSide === "long") {
        profitQuote = (currentPrice - entryPrice) * contracts * contractSize;
      } else {
        profitQuote = (entryPrice - currentPrice) * contracts * contractSize;
      }
      
      // Calculate net profit (gross - fees)
      const closeFees = this.calculateFeesForClose(opts, entryPrice, currentPrice, contractSize);
      netProfitQuote = profitQuote - closeFees;
    }

    // Close current position first. In preview mode we skip the close call and just preview the open.
    if (opts.mode === "live") {
      try {
        const closeResult = await closeFuturesPosition({
          apiKey: ctx.apiKey,
          secret: ctx.secret,
          symbol: opts.symbol,
        });
        // Emit close trade event
        const closeTrade: any = {
          ts: new Date().toISOString(),
          strategy: "futures-flip-momentum",
          exchange: "ccxt:coinbaseadvanced",
          mode: "live",
          symbol: opts.symbol,
          side: currentSide === "long" ? "sell" : "buy", // opposite of position side
          price: currentPrice,
          amount: contracts,
          orderId: (closeResult.order as any)?.id ?? "close",
          positionAction: "close",
        };
        if (profitQuote !== undefined) closeTrade.profitQuote = profitQuote;
        if (netProfitQuote !== undefined) closeTrade.netProfitQuote = netProfitQuote;
        ctx.emitTrade(closeTrade);
      } catch (e: any) {
        this.setStatus(ctx, { lastMessage: `close failed: ${e?.message ?? String(e)}` });
        return;
      }
    } else {
      // Preview mode: emit a close event anyway for UI visibility
      const previewCloseTrade: any = {
        ts: new Date().toISOString(),
        strategy: "futures-flip-momentum",
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
    await this.open(ctx, opts, next);
  }

  private checkFeeGateForFlip(ctx: Ctx, opts: { mode: FlipMode; symbol: string; contracts: number; cfg: FlipConfig }): boolean {
    // Disabled explicitly -> behave like naked trailing momentum.
    if (!opts.cfg.feeGateEnabled) {
      return true;
    }
    const price = this.status.lastPrice;
    const entry = this.status.entryPrice;
    const side = this.status.side;
    const contractSize = this.status.contractSize;

    // If we can't estimate, don't block.
    if (price == null || entry == null || !Number.isFinite(price) || !Number.isFinite(entry)) return true;
    if (side !== "long" && side !== "short") return true;
    if (contractSize == null || !Number.isFinite(contractSize) || contractSize <= 0) return true;

    const taker = opts.cfg.takerFeeRate ?? 0.001;
    const perContract = opts.cfg.perContractFeeUsd ?? 0.15;
    const mult = opts.cfg.minProfitMultiple ?? 1.5;

    const contracts = Math.abs(opts.contracts);
    // Calculate fees on actual entry/exit notional values
    const entryNotional = contracts * contractSize * entry;
    const exitNotional = contracts * contractSize * price;
    const entryFee = entryNotional * taker + contracts * perContract;
    const exitFee = exitNotional * taker + contracts * perContract;
    const flipFees = entryFee + exitFee; // close (entry fee) + open (exit fee)

    const grossPnl =
      side === "long"
        ? (price - entry) * contracts * contractSize
        : (entry - price) * contracts * contractSize;
    
    // Calculate NET profit (gross - fees for closing this position)
    // Note: flipFees includes both close + open fees, but for fee gate we only care about close fees
    const closeFees = entryFee + exitFee; // fees for closing current position
    const netPnl = grossPnl - closeFees;

    this.setStatus(ctx, { estimatedFlipFees: flipFees, estimatedGrossPnl: grossPnl, estimatedNetPnl: netPnl });

    // If we're *losing* on this leg (NET negative), always allow the flip (this acts like a stop/stop-and-reverse).
    // The fee gate is only meant to block unprofitable *scalps* when we are NET profitable.
    if (netPnl <= 0) {
      this.setStatus(ctx, {
        lastMessage: `flip allowed (loss-cut; fee gate only applies to NET profitable closes). netPnL=${netPnl.toFixed(
          2,
        )}, estFees=${flipFees.toFixed(2)}`,
      });
      return true;
    }

    // Only flip if NET profit exceeds fees * multiple
    if (netPnl <= flipFees * mult) {
      this.setStatus(ctx, {
        lastMessage: `flip blocked by fees gate: netPnL=${netPnl.toFixed(2)} <= ${mult}x fees=${(flipFees * mult).toFixed(2)} (fees=${flipFees.toFixed(2)})`,
      });
      return false;
    }
    return true;
  }
}


