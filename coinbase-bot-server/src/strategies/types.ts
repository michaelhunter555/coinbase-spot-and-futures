import type { Exchange } from "../exchange/types";
import type { TradeEvent } from "../events/trades";

export type StrategyStatus = "stopped" | "running" | "error";

export type StrategyContext = {
  exchange: Exchange;
  product: string;
  dataDir: string;
  mode: "paper" | "live";
  emitTrade: (trade: TradeEvent) => void;
};

export interface Strategy {
  getName(): string;
  getStatus(): StrategyStatus;
  getLastPrice(): number | null;
  getLastMessage(): string | null;
  getPositionExists(): boolean;
  getNextTargetBuyPrice(): number | undefined;
  getNextTargetSellPrice(): number | undefined;
  start(ctx: StrategyContext): Promise<void>;
  stop(): Promise<void>;
}


