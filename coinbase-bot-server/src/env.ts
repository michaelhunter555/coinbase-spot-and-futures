import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";

function findEnvFile(startDir: string): string | null {
  // Walk up a few levels to support running from repo root or coinbase-bot-server/
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function loadEnv() {
  const envFile = findEnvFile(process.cwd());
  if (envFile) dotenv.config({ path: envFile });
  else dotenv.config();
}

export type TradingMode = "paper" | "live";

export type AppConfig = {
  port: number;
  coinbaseApiKey: string | undefined;
  coinbaseApiSecret: string | undefined;

  defaultProduct: string; // CCXT symbol format e.g. BTC/USD
  defaultStrategy: "momentum";
  defaultMode: TradingMode;

  buyPositionDelta: number;
  sellPositionDelta: number;
  orderPriceDelta: number;
  stopLossDelta: number | null;

  quoteBalanceMinimum: number;
  maxQuoteToSpend: number;
};

function parseNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseOptionalNumber(name: string): number | null {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function normalizeProduct(product: string): string {
  const trimmed = product.trim();
  // allow BTC-USD style input
  if (trimmed.includes("-") && !trimmed.includes("/")) return trimmed.replace("-", "/");
  return trimmed;
}

export function getConfig(): AppConfig {
  const port = parseInt(process.env.PORT ?? "3001", 10);

  const defaultProduct = normalizeProduct(process.env.PRODUCT ?? "BTC/USD");
  const defaultStrategy = "momentum" as const;
  const modeRaw = (process.env.TRADING_MODE ?? "paper").toLowerCase();
  const defaultMode: TradingMode = modeRaw === "live" ? "live" : "paper";

  return {
    port: Number.isFinite(port) ? port : 3001,
    coinbaseApiKey: process.env.COINBASE_API_KEY,
    coinbaseApiSecret: process.env.COINBASE_API_SECRET,

    defaultProduct,
    defaultStrategy,
    defaultMode,

    buyPositionDelta: parseNumber("BUY_POSITION_DELTA", 0.015),
    sellPositionDelta: parseNumber("SELL_POSITION_DELTA", 0.02),
    orderPriceDelta: parseNumber("ORDER_PRICE_DELTA", 0.001),
    stopLossDelta: parseOptionalNumber("STOP_LOSS_DELTA"),

    quoteBalanceMinimum: parseNumber("QUOTE_BALANCE_MINIMUM", 0.06),
    maxQuoteToSpend: parseNumber("MAX_QUOTE_TO_SPEND", 25),
  };
}

export function normalizeProductSymbol(product: string): string {
  return normalizeProduct(product);
}


