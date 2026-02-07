import express from "express";
import mongoose from "mongoose";
import path from "node:path";
import { createServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { loadEnv, getConfig, normalizeProductSymbol, type TradingMode } from "./src/env";
import { StrategyRunner } from "./src/runner/strategyRunner";
import { probeDerivativeMarkets } from "./src/debug/markets";
import { previewOrder, type OrderPreviewRequest } from "./src/debug/orderPreview";
import { fetchAdvancedPortfolios } from "./src/debug/portfolios";
import {
  closeFuturesPosition,
  getFuturesBalanceSummary,
  getFuturesMarket,
  getFuturesPositions,
  placeFuturesOrder,
  previewFuturesOrder,
  type FuturesOrderRequest,
} from "./src/futures/cfmFutures";
import { FuturesFlipMomentumRunner, type FlipMode } from "./src/futures/flipMomentumRunner";
import {
  FuturesDirectionalMomentumRunner,
  type DirectionalMode,
} from "./src/futures/directionalMomentumRunner";
import { tradeExecuted } from "./src/db/controllers/trade-executed";

loadEnv();
const cfg = getConfig();

const app = express();
app.use(express.json({ limit: "256kb" }));

const runner = new StrategyRunner(cfg);
const futuresFlip = new FuturesFlipMomentumRunner();
const futuresMomentum = new FuturesDirectionalMomentumRunner();

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: true,
    methods: ["GET", "POST"],
  },
});

// Basic CORS for browser-based UI calls (Next dev server on a different port)
app.use((req, res, next) => {
  const origin = req.headers.origin ?? "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

io.on("connection", (socket) => {
  socket.emit("status", runner.getStatus());
});

runner.onTrade((trade) => {
  io.emit("trade", trade);
  // tradeExecuted(trade);
});

// Futures flip trades also use the same socket event
const emitFuturesTrade = (trade: any) => {
  io.emit("trade", trade);
};

// Heartbeat status so the UI can show liveness/lastPrice/lastMessage while running
setInterval(() => {
  io.emit("status", runner.getStatus());
  io.emit("futuresFlipStatus", futuresFlip.getStatus());
  io.emit("futuresMomentumStatus", futuresMomentum.getStatus());
}, 1000);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/status", (_req, res) => {
  res.json(runner.getStatus());
});

app.get("/debug/markets", async (_req, res) => {
  try {
    const results = await probeDerivativeMarkets();

    // eslint-disable-next-line no-console
    console.log(
      results.map((r) => ({
        exchangeId: r.exchangeId,
        ok: r.ok,
        total: r.totalMarkets,
        derivatives: r.derivativeCount,
        perpetualSwaps: r.perpetualSwapCount,
        perpLike: r.perpLikeCount,
        error: r.error,
        sample: r.sampleDerivatives?.slice(0, 5)?.map((s) => s.symbol),
        samplePerps: r.samplePerpetualSwaps?.slice(0, 5)?.map((s) => s.symbol),
      })),
    );

    res.json({ ok: true, results });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message ?? String(e) });
  }
});

app.get("/debug/portfolios", async (_req, res) => {
  try {
    if (!cfg.coinbaseApiKey || !cfg.coinbaseApiSecret) {
      res.status(400).json({ ok: false, error: "Missing COINBASE_API_KEY / COINBASE_API_SECRET" });
      return;
    }
    const portfolios = await fetchAdvancedPortfolios({ apiKey: cfg.coinbaseApiKey, secret: cfg.coinbaseApiSecret });

    // eslint-disable-next-line no-console
    console.log(
      "portfolios:",
      (portfolios ?? []).map((p: any) => ({
        id: p?.id,
        uuid: p?.info?.uuid ?? p?.uuid,
        name: p?.name,
        type: p?.type,
      })),
    );

    res.json({ ok: true, portfolios });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message ?? String(e) });
  }
});

app.post("/debug/orderPreview", async (req, res) => {
    console.log("orderPreview request");
  try {
    if (!cfg.coinbaseApiKey || !cfg.coinbaseApiSecret) {
      res.status(400).json({ ok: false, error: "Missing COINBASE_API_KEY / COINBASE_API_SECRET" });
      return;
    }

    console.log("pass first check");
    const body = req.body ?? {};
    const priceRaw = body.price;
    const parsedPrice = priceRaw != null ? Number(priceRaw) : undefined;
    const hasPositivePrice = parsedPrice != null && Number.isFinite(parsedPrice) && parsedPrice > 0;

    const retailPortfolioId =
      typeof body.retail_portfolio_id === "string"
        ? body.retail_portfolio_id
        : typeof body.portfolio === "string"
          ? body.portfolio
          : undefined;

    const previewReq: OrderPreviewRequest = {
      exchangeId: "coinbaseadvanced",
      symbol: String(body.symbol ?? "BTC/USDC:USDC"),
      type: (
        String(body.type ?? (hasPositivePrice ? "limit" : "market")).toLowerCase() === "limit" ? "limit" : "market"
      ) as "market" | "limit",
      side: (String(body.side ?? "sell").toLowerCase() === "buy" ? "buy" : "sell") as "buy" | "sell",
      amount: Number(body.amount ?? 0.0001),
      ...(hasPositivePrice ? { price: parsedPrice } : {}),
      ...(retailPortfolioId ? { retail_portfolio_id: retailPortfolioId } : {}),
      ...(body.leverage != null ? { leverage: Number(body.leverage) } : {}),
      ...(body.marginMode === "cross" || body.marginMode === "isolated" ? { marginMode: body.marginMode } : {}),
    };

    if (!Number.isFinite(previewReq.amount) || previewReq.amount <= 0) {
      res.status(400).json({ ok: false, error: "Invalid amount" });
      return;
    }
    if (previewReq.type === "limit" && (!Number.isFinite(previewReq.price) || (previewReq.price as number) <= 0)) {
      res.status(400).json({ ok: false, error: "Limit orders require a positive price" });
      return;
    }

    // eslint-disable-next-line no-console
    console.log("orderPreview request:", { ...previewReq, hasKey: true, hasSecret: true });

    const result = await previewOrder({
      apiKey: cfg.coinbaseApiKey,
      secret: cfg.coinbaseApiSecret,
      req: previewReq,
    });

    // eslint-disable-next-line no-console
    console.log("orderPreview response:", {
      symbol: previewReq.symbol,
      type: previewReq.type,
      side: previewReq.side,
      amount: previewReq.amount,
      price: previewReq.price,
      orderId: (result.order as any)?.id,
      status: (result.order as any)?.status,
      lastRequestUrl: (result as any)?.lastRequestUrl,
      lastJsonKeys:
        typeof (result as any)?.lastJson === "object" && (result as any)?.lastJson ? Object.keys((result as any).lastJson) : undefined,
    });

    res.json({ ok: true, request: previewReq, result });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (msg.includes("PortfolioIDResolver") || msg.toLowerCase().includes("portfolio not found")) {
      res.status(400).json({
        ok: false,
        error: msg,
        hint: "This usually means you must pass params.retail_portfolio_id for coinbaseadvanced derivatives. Call GET /debug/portfolios to list ids, then retry with { retail_portfolio_id: '<uuid>' }.",
      });
      return;
    }
    res.status(400).json({ ok: false, error: msg });
  }
});

// --- Futures (CFM) helpers (coinbaseadvanced) ---
app.get("/futures/market", async (req, res) => {
  try {
    if (!cfg.coinbaseApiKey || !cfg.coinbaseApiSecret) {
      res.status(400).json({ ok: false, error: "Missing COINBASE_API_KEY / COINBASE_API_SECRET" });
      return;
    }
    const symbol = String(req.query.symbol ?? "ETH/USD:USD-301220");
    const result = await getFuturesMarket({ apiKey: cfg.coinbaseApiKey, secret: cfg.coinbaseApiSecret, symbol });
    res.json({ ok: true, symbol, ...result });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message ?? String(e) });
  }
});

app.get("/futures/balance", async (_req, res) => {
  try {
    if (!cfg.coinbaseApiKey || !cfg.coinbaseApiSecret) {
      res.status(400).json({ ok: false, error: "Missing COINBASE_API_KEY / COINBASE_API_SECRET" });
      return;
    }
    const result = await getFuturesBalanceSummary({ apiKey: cfg.coinbaseApiKey, secret: cfg.coinbaseApiSecret });
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message ?? String(e) });
  }
});

app.get("/futures/positions", async (req, res) => {
  try {
    if (!cfg.coinbaseApiKey || !cfg.coinbaseApiSecret) {
      res.status(400).json({ ok: false, error: "Missing COINBASE_API_KEY / COINBASE_API_SECRET" });
      return;
    }
    const symbol = req.query.symbol ? String(req.query.symbol) : undefined;
    const args: { apiKey: string; secret: string; symbols?: string[] } = {
      apiKey: cfg.coinbaseApiKey,
      secret: cfg.coinbaseApiSecret,
    };
    if (symbol) args.symbols = [symbol];
    const result = await getFuturesPositions(args);
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message ?? String(e) });
  }
});

app.post("/futures/preview", async (req, res) => {
  try {
    if (!cfg.coinbaseApiKey || !cfg.coinbaseApiSecret) {
      res.status(400).json({ ok: false, error: "Missing COINBASE_API_KEY / COINBASE_API_SECRET" });
      return;
    }
    const body = req.body ?? {};
    const price = body.price != null ? Number(body.price) : undefined;
    const reqObj: FuturesOrderRequest = {
      symbol: String(body.symbol ?? "ETH/USD:USD-301220"),
      type: (String(body.type ?? "market").toLowerCase() === "limit" ? "limit" : "market") as any,
      side: (String(body.side ?? "buy").toLowerCase() === "sell" ? "sell" : "buy") as any,
      contracts: Math.trunc(Number(body.contracts ?? body.amount ?? 1)),
      ...(price != null && Number.isFinite(price) && price > 0 ? { price } : {}),
      ...(typeof body.retail_portfolio_id === "string" ? { retail_portfolio_id: body.retail_portfolio_id } : {}),
      ...(body.marginMode === "cross" || body.marginMode === "isolated" ? { marginMode: body.marginMode } : {}),
      ...(body.leverage != null ? { leverage: Number(body.leverage) } : {}),
    };
    if (!Number.isFinite(reqObj.contracts) || reqObj.contracts <= 0) {
      res.status(400).json({ ok: false, error: "contracts must be a positive integer" });
      return;
    }
    if (reqObj.type === "limit" && (!Number.isFinite(reqObj.price) || (reqObj.price as number) <= 0)) {
      res.status(400).json({ ok: false, error: "limit preview requires positive price" });
      return;
    }

    // eslint-disable-next-line no-console
    console.log("futures preview:", reqObj);
    const result = await previewFuturesOrder({ apiKey: cfg.coinbaseApiKey, secret: cfg.coinbaseApiSecret, req: reqObj });
    res.json({ ok: true, request: reqObj, result });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message ?? String(e) });
  }
});

app.post("/futures/order", async (req, res) => {
  try {
    if (!cfg.coinbaseApiKey || !cfg.coinbaseApiSecret) {
      res.status(400).json({ ok: false, error: "Missing COINBASE_API_KEY / COINBASE_API_SECRET" });
      return;
    }
    const body = req.body ?? {};
    if (body.execute !== true) {
      res.status(400).json({ ok: false, error: 'Set {"execute": true} to place a real futures order. Use /futures/preview first.' });
      return;
    }
    const price = body.price != null ? Number(body.price) : undefined;
    const reqObj: FuturesOrderRequest = {
      symbol: String(body.symbol ?? "ETH/USD:USD-301220"),
      type: (String(body.type ?? "market").toLowerCase() === "limit" ? "limit" : "market") as any,
      side: (String(body.side ?? "buy").toLowerCase() === "sell" ? "sell" : "buy") as any,
      contracts: Math.trunc(Number(body.contracts ?? body.amount ?? 1)),
      ...(price != null && Number.isFinite(price) && price > 0 ? { price } : {}),
      ...(typeof body.retail_portfolio_id === "string" ? { retail_portfolio_id: body.retail_portfolio_id } : {}),
      ...(body.marginMode === "cross" || body.marginMode === "isolated" ? { marginMode: body.marginMode } : {}),
      ...(body.leverage != null ? { leverage: Number(body.leverage) } : {}),
    };

    // eslint-disable-next-line no-console
    console.log("futures order EXECUTE:", reqObj);
    const result = await placeFuturesOrder({ apiKey: cfg.coinbaseApiKey, secret: cfg.coinbaseApiSecret, req: reqObj });
    res.json({ ok: true, request: reqObj, result });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message ?? String(e) });
  }
});

app.post("/futures/close", async (req, res) => {
  try {
    if (!cfg.coinbaseApiKey || !cfg.coinbaseApiSecret) {
      res.status(400).json({ ok: false, error: "Missing COINBASE_API_KEY / COINBASE_API_SECRET" });
      return;
    }
    const body = req.body ?? {};
    const symbol = String(body.symbol ?? "ETH/USD:USD-301220");
    const sizeContracts = body.contracts != null ? Math.trunc(Number(body.contracts)) : undefined;
    if (sizeContracts != null && (!Number.isFinite(sizeContracts) || sizeContracts <= 0)) {
      res.status(400).json({ ok: false, error: "contracts must be a positive integer when provided" });
      return;
    }
    // eslint-disable-next-line no-console
    console.log("futures close:", { symbol, sizeContracts });
    const result = await closeFuturesPosition({
      apiKey: cfg.coinbaseApiKey,
      secret: cfg.coinbaseApiSecret,
      symbol,
      ...(sizeContracts != null ? { sizeContracts } : {}),
    });
    res.json({ ok: true, symbol, ...result });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message ?? String(e) });
  }
});

// --- Futures flip momentum (preview/live) ---
app.get("/futures/flip/status", (_req, res) => {
  res.json({ ok: true, status: futuresFlip.getStatus() });
});

app.post("/futures/flip/start", async (req, res) => {
  try {
    if (!cfg.coinbaseApiKey || !cfg.coinbaseApiSecret) {
      res.status(400).json({ ok: false, error: "Missing COINBASE_API_KEY / COINBASE_API_SECRET" });
      return;
    }
    const body = req.body ?? {};
    const mode: FlipMode = String(body.mode ?? "preview").toLowerCase() === "live" ? "live" : "preview";
    const symbol = String(body.symbol ?? "ETH/USD:USD-301220");
    const contracts = Math.trunc(Number(body.contracts ?? 1));
    const buyDelta = Number(body.buyDelta ?? 0.01);
    const sellDelta = Number(body.sellDelta ?? 0.01);
    const entryShortDelta = body.entryShortDelta != null ? Number(body.entryShortDelta) : undefined;
    const pollMs = Math.trunc(Number(body.pollMs ?? 1000));
    const retail_portfolio_id = typeof body.retail_portfolio_id === "string" ? body.retail_portfolio_id : undefined;
    const takerFeeRate = body.takerFeeRate != null ? Number(body.takerFeeRate) : undefined;
    const makerFeeRate = body.makerFeeRate != null ? Number(body.makerFeeRate) : undefined;
    const perContractFeeUsd = body.perContractFeeUsd != null ? Number(body.perContractFeeUsd) : undefined;
    const minProfitMultiple = body.minProfitMultiple != null ? Number(body.minProfitMultiple) : undefined;
    const profitLockThreshold = body.profitLockThreshold != null ? Number(body.profitLockThreshold) : undefined;
    const feeGateEnabled = body.feeGateEnabled === true;

    if (!Number.isFinite(contracts) || contracts <= 0) throw new Error("contracts must be positive integer");
    if (!Number.isFinite(buyDelta) || buyDelta <= 0) throw new Error("buyDelta must be positive");
    if (!Number.isFinite(sellDelta) || sellDelta <= 0) throw new Error("sellDelta must be positive");
    if (entryShortDelta != null && (!Number.isFinite(entryShortDelta) || entryShortDelta <= 0)) throw new Error("entryShortDelta must be positive when provided");
    if (takerFeeRate != null && (!Number.isFinite(takerFeeRate) || takerFeeRate < 0)) throw new Error("takerFeeRate must be >= 0 when provided");
    if (makerFeeRate != null && (!Number.isFinite(makerFeeRate) || makerFeeRate < 0)) throw new Error("makerFeeRate must be >= 0 when provided");
    if (perContractFeeUsd != null && (!Number.isFinite(perContractFeeUsd) || perContractFeeUsd < 0)) throw new Error("perContractFeeUsd must be >= 0 when provided");
    if (minProfitMultiple != null && (!Number.isFinite(minProfitMultiple) || minProfitMultiple <= 0)) throw new Error("minProfitMultiple must be > 0 when provided");

    await futuresFlip.start(
      {
        apiKey: cfg.coinbaseApiKey,
        secret: cfg.coinbaseApiSecret,
        emitTrade: emitFuturesTrade,
        onStatus: (s) => io.emit("futuresFlipStatus", s),
      },
      {
        mode,
        symbol,
        contracts,
        cfg: {
          buyDelta,
          sellDelta,
          ...(entryShortDelta != null ? { entryShortDelta } : {}),
          ...(takerFeeRate != null ? { takerFeeRate } : {}),
          ...(makerFeeRate != null ? { makerFeeRate } : {}),
          ...(perContractFeeUsd != null ? { perContractFeeUsd } : {}),
          ...(minProfitMultiple != null ? { minProfitMultiple } : {}),
          ...(profitLockThreshold != null ? { profitLockThreshold } : {}),
          ...(feeGateEnabled ? { feeGateEnabled } : {}),
          pollMs,
          ...(retail_portfolio_id ? { retail_portfolio_id } : {}),
        },
      },
    );

    res.json({ ok: true, status: futuresFlip.getStatus() });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message ?? String(e) });
  }
});

app.post("/futures/flip/stop", async (_req, res) => {
  await futuresFlip.stop({ onStatus: (s) => io.emit("futuresFlipStatus", s) });
  res.json({ ok: true, status: futuresFlip.getStatus() });
});

// --- Futures directional momentum (single-leg long/short) ---
app.get("/futures/momentum/status", (_req, res) => {
  res.json({ ok: true, status: futuresMomentum.getStatus() });
});

app.post("/futures/momentum/start", async (req, res) => {
  try {
    if (!cfg.coinbaseApiKey || !cfg.coinbaseApiSecret) {
      res.status(400).json({ ok: false, error: "Missing COINBASE_API_KEY / COINBASE_API_SECRET" });
      return;
    }
    const body = req.body ?? {};
    const mode: DirectionalMode = String(body.mode ?? "preview").toLowerCase() === "live" ? "live" : "preview";
    const symbol = String(body.symbol ?? "ETH/USD:USD-301220");
    const contracts = Math.trunc(Number(body.contracts ?? 1));
    const side = String(body.side ?? "long").toLowerCase() === "short" ? "short" : "long";
    const buyDelta = Number(body.buyDelta ?? 0.01);
    const sellDelta = Number(body.sellDelta ?? 0.01);
    const pollMs = Math.trunc(Number(body.pollMs ?? 1000));
    const retail_portfolio_id =
      typeof body.retail_portfolio_id === "string" && body.retail_portfolio_id.length > 0
        ? body.retail_portfolio_id
        : undefined;
    const takerFeeRate = body.takerFeeRate != null ? Number(body.takerFeeRate) : undefined;
    const perContractFeeUsd = body.perContractFeeUsd != null ? Number(body.perContractFeeUsd) : undefined;
    const profitLockThreshold = body.profitLockThreshold != null ? Number(body.profitLockThreshold) : undefined;
    const trailingDistance = body.trailingDistance != null ? Number(body.trailingDistance) : undefined;
    const feeGateEnabled = body.feeGateEnabled === true;

    if (!Number.isFinite(contracts) || contracts <= 0) throw new Error("contracts must be positive integer");
    if (!Number.isFinite(buyDelta) || buyDelta <= 0) throw new Error("buyDelta must be positive");
    if (!Number.isFinite(sellDelta) || sellDelta <= 0) throw new Error("sellDelta must be positive");
    if (takerFeeRate != null && (!Number.isFinite(takerFeeRate) || takerFeeRate < 0)) {
      throw new Error("takerFeeRate must be >= 0 when provided");
    }
    if (perContractFeeUsd != null && (!Number.isFinite(perContractFeeUsd) || perContractFeeUsd < 0)) {
      throw new Error("perContractFeeUsd must be >= 0 when provided");
    }
    if (profitLockThreshold != null && (!Number.isFinite(profitLockThreshold) || profitLockThreshold <= 0)) {
      throw new Error("profitLockThreshold must be > 0 when provided");
    }
    if (trailingDistance != null && (!Number.isFinite(trailingDistance) || trailingDistance <= 0)) {
      throw new Error("trailingDistance must be > 0 when provided");
    }

    await futuresMomentum.start(
      {
        apiKey: cfg.coinbaseApiKey,
        secret: cfg.coinbaseApiSecret,
        emitTrade: emitFuturesTrade,
        onStatus: (s) => io.emit("futuresMomentumStatus", s),
      },
      {
        mode,
        symbol,
        contracts,
        side,
        cfg: {
          buyDelta,
          sellDelta,
          pollMs,
          ...(retail_portfolio_id ? { retail_portfolio_id } : {}),
          ...(takerFeeRate != null ? { takerFeeRate } : {}),
          ...(perContractFeeUsd != null ? { perContractFeeUsd } : {}),
          ...(profitLockThreshold != null ? { profitLockThreshold } : {}),
          ...(trailingDistance != null ? { trailingDistance } : {}),
          ...(feeGateEnabled ? { feeGateEnabled } : {}),
        },
      },
    );

    res.json({ ok: true, status: futuresMomentum.getStatus() });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message ?? String(e) });
  }
});

app.post("/futures/momentum/stop", async (_req, res) => {
  await futuresMomentum.stop({ onStatus: (s) => io.emit("futuresMomentumStatus", s) });
  res.json({ ok: true, status: futuresMomentum.getStatus() });
});

app.post("/start", async (req, res) => {
    console.log("start", req.body);
  try {
    const product = normalizeProductSymbol(String(req.body?.product ?? cfg.defaultProduct));
    const modeRaw = String(req.body?.mode ?? cfg.defaultMode).toLowerCase();
    const mode: TradingMode = modeRaw === "live" ? "live" : "paper";

    if (mode === "live") {
      if (!cfg.coinbaseApiKey || !cfg.coinbaseApiSecret) {
        res.status(400).json({ error: "Missing COINBASE_API_KEY/COINBASE_API_SECRET for live mode" });
        return;
      }
    }

    await runner.start({ product, mode });
    io.emit("status", runner.getStatus());
    res.json({ ok: true, status: runner.getStatus() });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? String(err) });
  }
});

app.post("/stop", async (_req, res) => {
  await runner.stop();
  io.emit("status", runner.getStatus());
  res.json({ ok: true, status: runner.getStatus() });
});

app.get("/", (_req, res) => {
  res.type("text/plain").send(
    [
      "coinbase-bot-server",
      "",
      "Endpoints:",
      "  GET  /health",
      "  GET  /status",
      "  POST /start   { product?: 'BTC/USD', mode?: 'paper'|'live' }",
      "  POST /stop",
      "",
      `Working dir: ${process.cwd()}`,
      `Config: dataDir=${path.resolve(process.cwd(), "data")}`,
    ].join("\n"),
  );
});
// const mongoUri = process.env.MONGO_DB_URI;

httpServer.listen(cfg.port, () => {
  // eslint-disable-next-line no-console
  console.log(`coinbase-bot-server listening on :${cfg.port}`);
});