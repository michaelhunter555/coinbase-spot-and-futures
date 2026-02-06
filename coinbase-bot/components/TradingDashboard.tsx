"use client";

import React, { useCallback, useMemo, useState } from "react";
import dayjs, { type Dayjs } from "dayjs";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { LineChart } from "@mui/x-charts/LineChart";
import { DatePicker, LocalizationProvider } from "@mui/x-date-pickers";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import { useTrades } from "../contexts/TradesContext";

type Row = {
  ts: string;
  t: number;
  symbol: string;
  instrument: "spot" | "futures";
  source: string;
  side: "buy" | "sell";
  price: number;
  amount: number;
  orderId: string;
  profitQuote?: number;
  netProfitQuote?: number;
  positionAction?: "open" | "close";
};

function money(n: number) {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toFixed(2)}`;
}

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

function tryParseJson(s: unknown): any | null {
  if (typeof s !== "string") return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function TradingDashboard() {
  const { connected, socketUrl, trades, serverStatus, futuresFlipStatus } = useTrades();

  const [currentProfitLoss, setCurrentProfitLoss] = useState<number | null>(0);

  const [from, setFrom] = useState<Dayjs | null>(dayjs().subtract(7, "day"));
  const [to, setTo] = useState<Dayjs | null>(dayjs());
  const [product, setProduct] = useState("SOL/USD");
  const [mode, setMode] = useState<"paper" | "live">("paper");
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [debugMarketsLoading, setDebugMarketsLoading] = useState(false);
  const [debugPortfoliosLoading, setDebugPortfoliosLoading] = useState(false);
  const [debugPreviewLoading, setDebugPreviewLoading] = useState(false);

  const [marketsJson, setMarketsJson] = useState<any>(null);
  const [portfoliosJson, setPortfoliosJson] = useState<any>(null);
  const [previewJson, setPreviewJson] = useState<any>(null);

  // Debug order preview inputs (coinbaseadvanced)
  const [dbgSymbol, setDbgSymbol] = useState("ETH/USD:USD-301220");
  const [dbgSide, setDbgSide] = useState<"buy" | "sell">("sell");
  const [dbgType, setDbgType] = useState<"market" | "limit">("market");
  const [dbgAmount, setDbgAmount] = useState("1");
  const [dbgPrice, setDbgPrice] = useState("60000");
  const [dbgRetailPortfolioId, setDbgRetailPortfolioId] = useState("77e9df5c-6aeb-58e2-91d7-907a67278983");

  // Futures (CFM) panel
  const [futSymbol, setFutSymbol] = useState("ETH/USD:USD-301220");
  const [futContracts, setFutContracts] = useState("1");
  const [futPreviewLoadingSide, setFutPreviewLoadingSide] = useState<"buy" | "sell" | null>(null);
  const [futBalanceLoading, setFutBalanceLoading] = useState(false);
  const [futMarketLoading, setFutMarketLoading] = useState(false);
  const [futPositionsLoading, setFutPositionsLoading] = useState(false);
  const [futPreviewJson, setFutPreviewJson] = useState<any>(null);
  const [futBalanceJson, setFutBalanceJson] = useState<any>(null);
  const [futMarketJson, setFutMarketJson] = useState<any>(null);
  const [futPositionsJson, setFutPositionsJson] = useState<any>(null);

  // Futures directional momentum (single-leg long/short)
  const [dirSymbol, setDirSymbol] = useState<string>("ETH/USD:USD-301220");
  const [dirContracts, setDirContracts] = useState<string>("1");
  const [dirSide, setDirSide] = useState<"long" | "short">("long");
  const [dirBuyDelta, setDirBuyDelta] = useState<string>("0.01");
  const [dirSellDelta, setDirSellDelta] = useState<string>("0.01");
  const [dirMode, setDirMode] = useState<"preview" | "live">("preview");
  const [dirTakerFeeRate, setDirTakerFeeRate] = useState<string>("0.0005");
  const [dirPerContractFeeUsd, setDirPerContractFeeUsd] = useState<string>("0.15");
  const [dirProfitLockThreshold, setDirProfitLockThreshold] = useState<string>("0.01");
  const [dirTrailingDistance, setDirTrailingDistance] = useState<string>("0.01");
  const [dirRetailPortfolioId, setDirRetailPortfolioId] = useState<string>("");
  const [dirStartLoading, setDirStartLoading] = useState(false);
  const [dirStopLoading, setDirStopLoading] = useState(false);
  const [dirStatus, setDirStatus] = useState<any | null>(null);

  const apiBase = socketUrl; // same origin as socket server in our setup
  const isRunning = serverStatus?.running ?? false;

  const doStart = useCallback(async () => {
    if (!apiBase) {
      setError("Missing NEXT_PUBLIC_SOCKET_IO (used as API base URL).");
      return;
    }
    setBusy("start");
    setError(null);
    try {
      const resp = await fetch(`${apiBase}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ product: product.trim(), mode }),
      });
      const json = (await resp.json()) as any;
      if (!resp.ok) throw new Error(json?.error ?? `Start failed (${resp.status})`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }, [apiBase, mode, product]);

  const doStop = useCallback(async () => {
    if (!apiBase) {
      setError("Missing NEXT_PUBLIC_SOCKET_IO (used as API base URL).");
      return;
    }
    setBusy("stop");
    setError(null);
    try {
      const resp = await fetch(`${apiBase}/stop`, { method: "POST" });
      const json = (await resp.json()) as any;
      if (!resp.ok) throw new Error(json?.error ?? `Stop failed (${resp.status})`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }, [apiBase]);

  const doDebugMarkets = useCallback(async () => {
    if (!apiBase) {
      setError("Missing NEXT_PUBLIC_SOCKET_IO (used as API base URL).");
      return;
    }
    setDebugMarketsLoading(true);
    setError(null);
    try {
      const resp = await fetch(`${apiBase}/debug/markets`, { method: "GET" });
      const json = (await resp.json()) as any;
      if (!resp.ok) throw new Error(`Debug markets failed (${resp.status}): ${json?.error ?? "Unknown error"}`);
      console.log("debug markets:", json);
      setMarketsJson(json);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setDebugMarketsLoading(false);
    }
  }, [apiBase]);

  const doDebugPortfolios = useCallback(async () => {
    if (!apiBase) {
      setError("Missing NEXT_PUBLIC_SOCKET_IO (used as API base URL).");
      return;
    }
    setDebugPortfoliosLoading(true);
    setError(null);
    try {
      const resp = await fetch(`${apiBase}/debug/portfolios`, { method: "GET" });
      const json = (await resp.json()) as any;
      if (!resp.ok) throw new Error(`Debug portfolios failed (${resp.status}): ${json?.error ?? "Unknown error"}`);
      console.log("debug portfolios:", json);
      setPortfoliosJson(json);

      // Convenience: if there is exactly one portfolio, auto-fill it.
      const list = Array.isArray(json?.portfolios) ? json.portfolios : [];
      if (list.length === 1 && typeof list[0]?.id === "string") {
        setDbgRetailPortfolioId(list[0].id);
      }
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setDebugPortfoliosLoading(false);
    }
  }, [apiBase]);

  const doDebugOrderPreview = useCallback(async () => {
    if (!apiBase) {
      setError("Missing NEXT_PUBLIC_SOCKET_IO (used as API base URL).");
      return;
    }
    setDebugPreviewLoading(true);
    setError(null);
    try {
      const amount = Number(dbgAmount);
      const price = Number(dbgPrice);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Preview amount must be a positive number");
      if (dbgType === "limit" && (!Number.isFinite(price) || price <= 0)) throw new Error("Limit preview requires a positive price");

      const body: any = {
        symbol: dbgSymbol.trim(),
        side: dbgSide,
        type: dbgType,
        amount,
      };
      if (dbgType === "limit") body.price = price;
      if (dbgRetailPortfolioId.trim()) body.retail_portfolio_id = dbgRetailPortfolioId.trim();

      const resp = await fetch(`${apiBase}/debug/orderPreview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await resp.json()) as any;
      if (!resp.ok) throw new Error(`Order preview failed (${resp.status}): ${json?.error ?? "Unknown error"}`);
      console.log("debug order preview:", json);
      setPreviewJson(json);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setDebugPreviewLoading(false);
    }
  }, [apiBase, dbgAmount, dbgPrice, dbgRetailPortfolioId, dbgSide, dbgSymbol, dbgType]);

  const doFutRefreshMarket = useCallback(async () => {
    if (!apiBase) {
      setError("Missing NEXT_PUBLIC_SOCKET_IO (used as API base URL).");
      return;
    }
    setFutMarketLoading(true);
    setError(null);
    try {
      const resp = await fetch(`${apiBase}/futures/market?symbol=${encodeURIComponent(futSymbol.trim())}`);
      const json = (await resp.json()) as any;
      if (!resp.ok) throw new Error(`Futures market failed (${resp.status}): ${json?.error ?? "Unknown error"}`);
      setFutMarketJson(json);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setFutMarketLoading(false);
    }
  }, [apiBase, futSymbol]);

  const doFutRefreshBalance = useCallback(async () => {
    if (!apiBase) {
      setError("Missing NEXT_PUBLIC_SOCKET_IO (used as API base URL).");
      return;
    }
    setFutBalanceLoading(true);
    setError(null);
    try {
      const resp = await fetch(`${apiBase}/futures/balance`);
      const json = (await resp.json()) as any;
      if (!resp.ok) throw new Error(`Futures balance failed (${resp.status}): ${json?.error ?? "Unknown error"}`);
      setFutBalanceJson(json);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setFutBalanceLoading(false);
    }
  }, [apiBase]);

  const doFutRefreshPositions = useCallback(async () => {
    if (!apiBase) {
      setError("Missing NEXT_PUBLIC_SOCKET_IO (used as API base URL).");
      return;
    }
    setFutPositionsLoading(true);
    setError(null);
    try {
      const resp = await fetch(`${apiBase}/futures/positions?symbol=${encodeURIComponent(futSymbol.trim())}`);
      const json = (await resp.json()) as any;
      if (!resp.ok) throw new Error(`Futures positions failed (${resp.status}): ${json?.error ?? "Unknown error"}`);
      setFutPositionsJson(json);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setFutPositionsLoading(false);
    }
  }, [apiBase, futSymbol]);

  const doFutPreview = useCallback(
    async (side: "buy" | "sell") => {
      if (!apiBase) {
        setError("Missing NEXT_PUBLIC_SOCKET_IO (used as API base URL).");
        return;
      }
      setFutPreviewLoadingSide(side);
      setError(null);
      try {
        const contracts = Math.trunc(Number(futContracts));
        if (!Number.isFinite(contracts) || contracts <= 0) throw new Error("Contracts must be a positive integer");

        const body = {
          symbol: futSymbol.trim(),
          type: "market",
          side,
          contracts,
          retail_portfolio_id: dbgRetailPortfolioId.trim() || undefined,
        };

        const resp = await fetch(`${apiBase}/futures/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await resp.json()) as any;
        if (!resp.ok) throw new Error(`Futures preview failed (${resp.status}): ${json?.error ?? "Unknown error"}`);
        setFutPreviewJson(json);
      } catch (e: any) {
        setError(e?.message ?? String(e));
      } finally {
        setFutPreviewLoadingSide(null);
      }
    },
    [apiBase, dbgRetailPortfolioId, futContracts, futSymbol],
  );

  const [flipStartLoading, setFlipStartLoading] = useState(false);
  const [flipStopLoading, setFlipStopLoading] = useState(false);
  const [flipSymbol, setFlipSymbol] = useState("ETH/USD:USD-301220");
  const [flipContracts, setFlipContracts] = useState("1");
  // Aggressive (scalping) defaults:
  // - buyDelta: 0.8% - 1.2% (we default to 1.0%)
  // - sellDelta: 1.0% - 1.5% (we default to 1.25%)
  // - entryShortDelta (flat->short): 1.5%
  const [flipBuyDelta, setFlipBuyDelta] = useState("0.01");
  const [flipSellDelta, setFlipSellDelta] = useState("0.0125");
  const [flipEntryShortDelta, setFlipEntryShortDelta] = useState("0.015");
  const [flipTakerFeeRate, setFlipTakerFeeRate] = useState("0.001");
  const [flipPerContractFeeUsd, setFlipPerContractFeeUsd] = useState("0.15");
  const [flipMinProfitMultiple, setFlipMinProfitMultiple] = useState("1.5");
  const [flipProfitLockThreshold, setFlipProfitLockThreshold] = useState("0.01");
  const [flipProfitMode, setFlipProfitMode] = useState<"naked" | "profit-bound">("profit-bound");
  const [flipMode, setFlipMode] = useState<"preview" | "live">("preview");

  const doFlipStart = useCallback(async () => {
    if (!apiBase) {
      setError("Missing NEXT_PUBLIC_SOCKET_IO (used as API base URL).");
      return;
    }
    setFlipStartLoading(true);
    setError(null);
    try {
      const body = {
        mode: flipMode,
        symbol: flipSymbol.trim(),
        contracts: Math.trunc(Number(flipContracts)),
        buyDelta: Number(flipBuyDelta),
        sellDelta: Number(flipSellDelta),
        entryShortDelta: Number(flipEntryShortDelta),
        takerFeeRate: Number(flipTakerFeeRate),
        perContractFeeUsd: Number(flipPerContractFeeUsd),
        minProfitMultiple: Number(flipMinProfitMultiple),
        profitLockThreshold: flipProfitMode === "profit-bound" ? Number(flipProfitLockThreshold) : undefined,
        feeGateEnabled: flipProfitMode === "profit-bound",
        retail_portfolio_id: dbgRetailPortfolioId.trim() || undefined,
      };
      const resp = await fetch(`${apiBase}/futures/flip/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await resp.json()) as any;
      if (!resp.ok) throw new Error(`Flip start failed (${resp.status}): ${json?.error ?? "Unknown error"}`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setFlipStartLoading(false);
    }
  }, [
    apiBase,
    dbgRetailPortfolioId,
    flipBuyDelta,
    flipContracts,
    flipEntryShortDelta,
    flipMinProfitMultiple,
    flipMode,
    flipPerContractFeeUsd,
    flipSellDelta,
    flipSymbol,
    flipTakerFeeRate,
    flipProfitMode,
  ]);

  const doFlipStop = useCallback(async () => {
    if (!apiBase) {
      setError("Missing NEXT_PUBLIC_SOCKET_IO (used as API base URL).");
      return;
    }
    setFlipStopLoading(true);
    setError(null);
    try {
      const resp = await fetch(`${apiBase}/futures/flip/stop`, { method: "POST" });
      const json = (await resp.json()) as any;
      if (!resp.ok) throw new Error(`Flip stop failed (${resp.status}): ${json?.error ?? "Unknown error"}`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setFlipStopLoading(false);
    }
  }, [apiBase]);

  // Futures directional momentum: start/stop
  const doDirStart = useCallback(async () => {
    if (!apiBase) {
      setError("Missing NEXT_PUBLIC_SOCKET_IO (used as API base URL).");
      return;
    }
    setDirStartLoading(true);
    setError(null);
    try {
      const body: any = {
        mode: dirMode,
        symbol: dirSymbol.trim(),
        contracts: Math.trunc(Number(dirContracts)),
        side: dirSide,
        buyDelta: Number(dirBuyDelta),
        sellDelta: Number(dirSellDelta),
        takerFeeRate: Number(dirTakerFeeRate),
        perContractFeeUsd: Number(dirPerContractFeeUsd),
        profitLockThreshold: Number(dirProfitLockThreshold),
        trailingDistance: Number(dirTrailingDistance),
        feeGateEnabled: true,
        retail_portfolio_id: (dirRetailPortfolioId || dbgRetailPortfolioId).trim() || undefined,
      };
      const resp = await fetch(`${apiBase}/futures/momentum/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await resp.json()) as any;
      if (!resp.ok) throw new Error(`Directional start failed (${resp.status}): ${json?.error ?? "Unknown error"}`);
      setDirStatus(json.status ?? null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setDirStartLoading(false);
    }
  }, [
    apiBase,
    dirMode,
    dirSymbol,
    dirContracts,
    dirSide,
    dirBuyDelta,
    dirSellDelta,
    dirTakerFeeRate,
    dirPerContractFeeUsd,
    dirProfitLockThreshold,
    dirTrailingDistance,
    dirRetailPortfolioId,
    dbgRetailPortfolioId,
  ]);

  const doDirStop = useCallback(async () => {
    if (!apiBase) {
      setError("Missing NEXT_PUBLIC_SOCKET_IO (used as API base URL).");
      return;
    }
    setDirStopLoading(true);
    setError(null);
    try {
      const resp = await fetch(`${apiBase}/futures/momentum/stop`, { method: "POST" });
      const json = (await resp.json()) as any;
      if (!resp.ok) throw new Error(`Directional stop failed (${resp.status}): ${json?.error ?? "Unknown error"}`);
      setDirStatus(json.status ?? null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setDirStopLoading(false);
    }
  }, [apiBase]);

  const previewIssues = useMemo(() => {
    const lastHttp = previewJson?.result?.lastHttpResponse;
    const parsed = tryParseJson(lastHttp);
    if (!parsed) return null;
    const errs = Array.isArray(parsed.errs) ? parsed.errs.filter((x: any) => typeof x === "string") : [];
    const warning = Array.isArray(parsed.warning) ? parsed.warning.filter((x: any) => typeof x === "string") : [];
    return { errs, warning, parsed };
  }, [previewJson]);

  const rows = useMemo<Row[]>(() => {
    const mapped = trades
      .map((t) => {
        const isFutures = t.symbol.includes(":") || t.exchange.includes("coinbaseadvanced") || t.strategy.includes("futures");
        const instrument: Row["instrument"] = isFutures ? "futures" : "spot";
        return {
          ts: t.ts,
          t: new Date(t.ts).getTime(),
          symbol: t.symbol,
          instrument,
          source: `${t.strategy} · ${t.exchange} · ${t.mode}`,
          side: t.side,
          price: t.price,
          amount: t.amount,
          orderId: t.orderId,
          ...(t.profitQuote !== undefined ? { profitQuote: t.profitQuote } : {}),
          ...(t.netProfitQuote !== undefined ? { netProfitQuote: t.netProfitQuote } : {}),
          ...(t.positionAction ? { positionAction: t.positionAction } : {}),
        };
      })
      .filter((r) => Number.isFinite(r.t));

    const fromMs = from?.startOf("day").valueOf() ?? null;
    const toMs = to?.endOf("day").valueOf() ?? null;

    return mapped.filter((r) => {
      if (fromMs != null && r.t < fromMs) return false;
      if (toMs != null && r.t > toMs) return false;
      return true;
    });
  }, [trades, from, to]);

  const stats = useMemo(() => {
    // For futures, profitQuote is on CLOSE events (positionAction="close"), not just "sell" side
    // For spot, profitQuote is on "sell" side
    // Use NET profit as primary metric (after fees)
    // Count all CLOSE events (even if profit isn't calculated yet)
    const closes = rows.filter((r) => {
      if (r.positionAction === "close") return true; // Count all CLOSE events
      if (!r.positionAction && r.side === "sell" && (typeof r.netProfitQuote === "number" || typeof r.profitQuote === "number")) return true;
      return false;
    });
    // Use net profit if available, fallback to gross profit
    const profit = closes.reduce((acc, r) => acc + (r.netProfitQuote ?? r.profitQuote ?? 0), 0);
    const wins = closes.filter((r) => (r.netProfitQuote ?? r.profitQuote ?? 0) > 0).length;
    const losses = closes.filter((r) => (r.netProfitQuote ?? r.profitQuote ?? 0) < 0).length;
    const winRate = closes.length > 0 ? wins / closes.length : 0;
    const avg = closes.length > 0 ? profit / closes.length : 0;
    return {
      tradeCount: rows.length,
      sellCount: closes.length,
      profit,
      wins,
      losses,
      winRate,
      avg,
    };
  }, [rows]);

  const chart = useMemo(() => {
    // Cumulative profit across CLOSE events (positionAction="close") or SELL trades (for spot)
    // Use NET profit as primary, with gross as secondary line
    // Include all CLOSE events (even if profit isn't calculated yet - will show 0)
    const points = rows
      .filter((r) => {
        if (r.positionAction === "close") return true; // Include all CLOSE events
        if (!r.positionAction && r.side === "sell" && (typeof r.netProfitQuote === "number" || typeof r.profitQuote === "number")) return true;
        return false;
      })
      .sort((a, b) => a.t - b.t);

    let cumGross = 0;
    let cumNet = 0;
    const x: number[] = [];
    const yGross: number[] = [];
    const yNet: number[] = [];

    for (const p of points) {
      cumGross += p.profitQuote ?? 0;
      cumNet += p.netProfitQuote ?? p.profitQuote ?? 0; // use net if available, fallback to gross
      x.push(p.t);
      yGross.push(Number(cumGross.toFixed(4)));
      yNet.push(Number(cumNet.toFixed(4)));
    }

    return { x, yGross, yNet };
  }, [rows]);

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <Box sx={{ p: { xs: 2, md: 4 }, maxWidth: 1200, mx: "auto" }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2} sx={{ mb: 2 }}>
          <Box>
            <Typography variant="h4" fontWeight={700}>
              Trading Dashboard
            </Typography>
            <Typography sx={{ color: "white" }} variant="body2" color="text.secondary">
              Socket: {socketUrl ?? "(missing NEXT_PUBLIC_SOCKET_IO)"}
            </Typography>
          </Box>
          <Stack direction="row" spacing={1}>
             <Button variant="contained" onClick={doDebugMarkets}>
                {debugMarketsLoading ? <CircularProgress size={20} /> : "Log Markets"}
                </Button> 
            <Button variant="outlined" onClick={doDebugPortfolios} disabled={!connected || debugPortfoliosLoading}>
              {debugPortfoliosLoading ? <CircularProgress size={20} /> : "Portfolios"}
            </Button>
          </Stack>
          <Chip
            sx={{ color: "white" }}
            label={connected ? "Connected" : "Disconnected"}
            color={connected ? "success" : "default"}
            variant={connected ? "filled" : "outlined"}
          />
        </Stack>

        {error && (
          <Alert onClose={() => setError(null)} severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <Card sx={{ mb: 2 }}>
          <CardContent>
            <Stack direction={{ xs: "column", md: "row" }} spacing={2} alignItems={{ md: "center" }}>
              <Box sx={{ flex: 1 }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography variant="h6" fontWeight={700}>
                    Spot Momentum Bot
                  </Typography>
                  <Chip size="small" color="info" variant="outlined" label="SPOT" />
                </Stack>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  Strategy: {serverStatus?.strategy ?? "—"} · Running: {serverStatus?.running ? "yes" : "no"} · Last msg:{" "}
                  {serverStatus?.lastMessage ?? "—"}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                  This panel calls <code>/start</code> + <code>/stop</code> (spot momentum). Futures controls are in the Futures panels below.
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                  Last price: {serverStatus?.lastPrice != null ? serverStatus.lastPrice.toFixed(2) : "—"} · Exchange:{" "}
                  {serverStatus?.exchange ?? "—"} · Mode: {serverStatus?.mode ?? "—"}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                  Position: {serverStatus?.positionExists ? "IN" : "FLAT"} ·{" "}
                  {serverStatus?.positionExists ? (
                    <>
                      Sell trigger:{" "}
                      {serverStatus?.nextTargetSellPrice != null ? serverStatus.nextTargetSellPrice.toFixed(2) : "—"}
                    </>
                  ) : (
                    <>
                      Buy trigger:{" "}
                      {serverStatus?.nextTargetBuyPrice != null ? serverStatus.nextTargetBuyPrice.toFixed(2) : "—"}
                    </>
                  )}
                </Typography>
              </Box>

              <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems={{ sm: "center" }}>
                <TextField
                  label="Product"
                  value={product}
                  onChange={(e) => setProduct(e.target.value)}
                  placeholder="BTC/USD"
                  size="small"
                />
                <FormControl size="small" sx={{ minWidth: 140 }}>
                  <InputLabel id="mode-label">Mode</InputLabel>
                  <Select
                    labelId="mode-label"
                    value={mode}
                    label="Mode"
                    onChange={(e) => setMode(e.target.value as "paper" | "live")}
                  >
                    <MenuItem value="paper">paper</MenuItem>
                    <MenuItem value="live">live</MenuItem>
                  </Select>
                </FormControl>

                <Stack direction="row" spacing={1}>
                  <Button variant="contained" onClick={doStart} disabled={busy !== null || !connected || isRunning}>
                    {busy === "start" ? "Starting..." : "Start"}
                  </Button>
                  <Button variant="outlined" color="error" onClick={doStop} disabled={busy !== null || !connected || !isRunning}>
                    {busy === "stop" ? "Stopping..." : "Stop"}
                  </Button>
                </Stack>
              </Stack>
            </Stack>
          </CardContent>
        </Card>

        {/* Futures directional momentum (single leg long/short) */}
        <Card sx={{ mb: 2 }}>
          <CardContent>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="h6" fontWeight={700}>
                Futures Directional Momentum (single leg)
              </Typography>
              <Chip size="small" color="warning" variant="outlined" label="FUTURES" />
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Runs a single LONG or SHORT futures leg using momentum deltas, with profit lock + trailing stop. Start in{" "}
              <b>preview</b> mode.
            </Typography>

            <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ mt: 2 }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                  <TextField
                    label="Symbol"
                    value={dirSymbol}
                    onChange={(e) => setDirSymbol(e.target.value)}
                    size="small"
                    fullWidth
                  />
                  <TextField
                    label="Contracts"
                    value={dirContracts}
                    onChange={(e) => setDirContracts(e.target.value)}
                    size="small"
                    sx={{ minWidth: 140 }}
                  />
                </Stack>

                <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mt: 2 }}>
                  <FormControl size="small" sx={{ minWidth: 140 }}>
                    <InputLabel id="dir-side-label">Side</InputLabel>
                    <Select
                      labelId="dir-side-label"
                      value={dirSide}
                      label="Side"
                      onChange={(e) => setDirSide(e.target.value as "long" | "short")}
                    >
                      <MenuItem value="long">Long</MenuItem>
                      <MenuItem value="short">Short</MenuItem>
                    </Select>
                  </FormControl>
                  <TextField
                    label="Buy delta"
                    value={dirBuyDelta}
                    onChange={(e) => setDirBuyDelta(e.target.value)}
                    size="small"
                    fullWidth
                  />
                  <TextField
                    label="Sell delta"
                    value={dirSellDelta}
                    onChange={(e) => setDirSellDelta(e.target.value)}
                    size="small"
                    fullWidth
                  />
                </Stack>

                <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mt: 2 }}>
                  <FormControl size="small" sx={{ minWidth: 140 }}>
                    <InputLabel id="dir-mode-label">Mode</InputLabel>
                    <Select
                      labelId="dir-mode-label"
                      value={dirMode}
                      label="Mode"
                      onChange={(e) => setDirMode(e.target.value as "preview" | "live")}
                    >
                      <MenuItem value="preview">preview</MenuItem>
                      <MenuItem value="live">live</MenuItem>
                    </Select>
                  </FormControl>
                  <TextField
                    label="Taker fee rate"
                    value={dirTakerFeeRate}
                    onChange={(e) => setDirTakerFeeRate(e.target.value)}
                    size="small"
                    fullWidth
                  />
                  <TextField
                    label="$ per contract"
                    value={dirPerContractFeeUsd}
                    onChange={(e) => setDirPerContractFeeUsd(e.target.value)}
                    size="small"
                    fullWidth
                  />
                </Stack>

                <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mt: 2 }}>
                  <TextField
                    label="Profit lock threshold (net %)"
                    value={dirProfitLockThreshold}
                    onChange={(e) => setDirProfitLockThreshold(e.target.value)}
                    size="small"
                    fullWidth
                  />
                  <TextField
                    label="Trailing distance (net %)"
                    value={dirTrailingDistance}
                    onChange={(e) => setDirTrailingDistance(e.target.value)}
                    size="small"
                    fullWidth
                  />
                  <TextField
                    label="retail_portfolio_id (optional)"
                    value={dirRetailPortfolioId}
                    onChange={(e) => setDirRetailPortfolioId(e.target.value)}
                    size="small"
                    fullWidth
                  />
                </Stack>

                <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: "wrap" }} useFlexGap>
                  <Button
                    variant="contained"
                    onClick={doDirStart}
                    disabled={!connected || dirStartLoading}
                  >
                    {dirStartLoading ? <CircularProgress size={20} /> : "Start Directional"}
                  </Button>
                  <Button
                    variant="outlined"
                    color="error"
                    onClick={doDirStop}
                    disabled={!connected || dirStopLoading}
                  >
                    {dirStopLoading ? <CircularProgress size={20} /> : "Stop & Close"}
                  </Button>
                </Stack>
              </Box>

              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" color="text.secondary" component="div">
                  Status: {dirStatus?.running ? "running" : "stopped"} · Side:{" "}
                  {dirStatus?.side ?? "—"} · Desired: {dirStatus?.desiredSide ?? "—"}
                  <br />
                  Last price:{" "}
                  {dirStatus?.lastPrice != null ? Number(dirStatus.lastPrice).toFixed(2) : "—"}
                  {dirStatus?.entryPrice != null && (
                    <> · Entry: {Number(dirStatus.entryPrice).toFixed(2)}</>
                  )}
                  <br />
                  Next entry:{" "}
                  {dirStatus?.nextEntryPrice != null
                    ? Number(dirStatus.nextEntryPrice).toFixed(2)
                    : "—"}
                  <br />
                  Est. net PnL:{" "}
                  {typeof dirStatus?.estimatedNetPnl === "number"
                    ? money(dirStatus.estimatedNetPnl)
                    : "—"}
                  {dirStatus?.profitLocked && (
                    <>
                      {" "}
                      · <Chip size="small" label="PROFIT LOCKED" color="success" variant="filled" />
                      {typeof dirStatus?.maxProfitAchieved === "number" && (
                        <> · High-water: {pct(dirStatus.maxProfitAchieved)}</>
                      )}
                      {typeof dirStatus?.trailingStopPrice === "number" && (
                        <> · Trailing stop: {Number(dirStatus.trailingStopPrice).toFixed(2)}</>
                      )}
                    </>
                  )}
                </Typography>
              </Box>
            </Stack>
          </CardContent>
        </Card>

        <Card sx={{ mb: 2 }}>
          <CardContent>
            <Stack direction={{ xs: "column", md: "row" }} spacing={2} alignItems={{ md: "flex-start" }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="h6" fontWeight={700}>
                  Derivatives Debug (coinbaseadvanced)
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  Use these while we figure out derivatives auth/config. They call server endpoints and print JSON below.
                </Typography>

                {previewIssues?.errs?.length ? (
                  <Alert severity="warning" sx={{ mt: 2 }}>
                    Preview returned errors:
                    <Box component="ul" sx={{ m: 0, mt: 1, pl: 2 }}>
                      {previewIssues.errs.map((e: string) => (
                        <li key={e}>
                          <Typography component="span" variant="body2">
                            {e === "PREVIEW_INSUFFICIENT_FUNDS_FOR_FUTURES"
                              ? "Insufficient funds/margin in your CFM futures account for this contract size. Fund futures or lower contracts."
                              : e}
                          </Typography>
                        </li>
                      ))}
                    </Box>
                  </Alert>
                ) : null}

                <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mt: 2 }}>
                  <TextField label="Symbol" value={dbgSymbol} onChange={(e) => setDbgSymbol(e.target.value)} size="small" fullWidth />
                  <FormControl size="small" sx={{ minWidth: 140 }}>
                    <InputLabel id="dbg-side-label">Side</InputLabel>
                    <Select labelId="dbg-side-label" value={dbgSide} label="Side" onChange={(e) => setDbgSide(e.target.value as any)}>
                      <MenuItem value="buy">buy</MenuItem>
                      <MenuItem value="sell">sell</MenuItem>
                    </Select>
                  </FormControl>
                  <FormControl size="small" sx={{ minWidth: 140 }}>
                    <InputLabel id="dbg-type-label">Type</InputLabel>
                    <Select labelId="dbg-type-label" value={dbgType} label="Type" onChange={(e) => setDbgType(e.target.value as any)}>
                      <MenuItem value="market">market</MenuItem>
                      <MenuItem value="limit">limit</MenuItem>
                    </Select>
                  </FormControl>
                </Stack>

                <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mt: 2 }}>
                  <TextField label="Amount" value={dbgAmount} onChange={(e) => setDbgAmount(e.target.value)} size="small" fullWidth />
                  <TextField
                    label="Price (limit only)"
                    value={dbgPrice}
                    onChange={(e) => setDbgPrice(e.target.value)}
                    size="small"
                    fullWidth
                    disabled={dbgType !== "limit"}
                  />
                  <TextField
                    label="retail_portfolio_id (optional)"
                    value={dbgRetailPortfolioId}
                    onChange={(e) => setDbgRetailPortfolioId(e.target.value)}
                    size="small"
                    fullWidth
                  />
                </Stack>

                <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
                  <Button variant="outlined" onClick={doDebugOrderPreview} disabled={!connected || debugPreviewLoading}>
                    {debugPreviewLoading ? <CircularProgress size={20} /> : "Preview Order"}
                  </Button>
                </Stack>
              </Box>

              <Divider flexItem orientation="vertical" sx={{ display: { xs: "none", md: "block" } }} />

              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="subtitle2" color="text.secondary">
                  Latest debug JSON
                </Typography>
                <Box
                  component="pre"
                  sx={{
                    mt: 1,
                    p: 1.5,
                    borderRadius: 1,
                    bgcolor: "rgba(255,255,255,0.06)",
                    maxWidth: "100%",
                    minWidth: 0,
                    overflowX: "auto",
                    maxHeight: 320,
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                    fontSize: 12,
                    lineHeight: 1.4,
                  }}
                >
                  {previewJson
                    ? JSON.stringify(previewJson, null, 2)
                    : portfoliosJson
                      ? JSON.stringify(portfoliosJson, null, 2)
                      : marketsJson
                        ? JSON.stringify(marketsJson, null, 2)
                        : "// click Log Markets / Portfolios / Preview Order"}
                </Box>
              </Box>
            </Stack>
          </CardContent>
        </Card>

        <Card sx={{ mb: 2 }}>
          <CardContent>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="h6" fontWeight={700}>
                Futures (CFM) — Long/Short Preview
              </Typography>
              <Chip size="small" color="warning" variant="outlined" label="FUTURES" />
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Uses <code>/futures/*</code> endpoints (coinbaseadvanced). Contracts are integers (min is usually 1).
            </Typography>

            <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ mt: 2 }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                  <TextField
                    label="Futures symbol"
                    value={futSymbol}
                    onChange={(e) => setFutSymbol(e.target.value)}
                    size="small"
                    fullWidth
                  />
                  <TextField
                    label="Contracts"
                    value={futContracts}
                    onChange={(e) => setFutContracts(e.target.value)}
                    size="small"
                    sx={{ minWidth: 140 }}
                  />
                </Stack>

                <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: "wrap" }} useFlexGap>
                  <Button variant="outlined" onClick={doFutRefreshMarket} disabled={!connected || futMarketLoading}>
                    {futMarketLoading ? <CircularProgress size={20} /> : "Market"}
                  </Button>
                  <Button variant="outlined" onClick={doFutRefreshBalance} disabled={!connected || futBalanceLoading}>
                    {futBalanceLoading ? <CircularProgress size={20} /> : "Balance"}
                  </Button>
                  <Button variant="outlined" onClick={doFutRefreshPositions} disabled={!connected || futPositionsLoading}>
                    {futPositionsLoading ? <CircularProgress size={20} /> : "Positions"}
                  </Button>
                </Stack>

                <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: "wrap" }} useFlexGap>
                  <Button
                    variant="contained"
                    onClick={() => doFutPreview("buy")}
                    disabled={!connected || futPreviewLoadingSide !== null}
                  >
                    {futPreviewLoadingSide === "buy" ? <CircularProgress size={20} /> : "Preview LONG (BUY)"}
                  </Button>
                  <Button
                    variant="contained"
                    color="error"
                    onClick={() => doFutPreview("sell")}
                    disabled={!connected || futPreviewLoadingSide !== null}
                  >
                    {futPreviewLoadingSide === "sell" ? <CircularProgress size={20} /> : "Preview SHORT (SELL)"}
                  </Button>
                </Stack>

                <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                  Contract meta (from market endpoint):
                  <br />
                  contractSize: {futMarketJson?.market?.contractSize ?? "—"} · min contracts:{" "}
                  {futMarketJson?.market?.limits?.amount?.min ?? "—"} · amount precision:{" "}
                  {futMarketJson?.market?.precision?.amount ?? "—"}
                </Typography>
              </Box>

              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="subtitle2" color="text.secondary">
                  Futures JSON
                </Typography>
                <Box
                  component="pre"
                  sx={{
                    mt: 1,
                    p: 1.5,
                    borderRadius: 1,
                    bgcolor: "rgba(255,255,255,0.06)",
                    maxWidth: "100%",
                    minWidth: 0,
                    overflowX: "auto",
                    maxHeight: 360,
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                    fontSize: 12,
                    lineHeight: 1.4,
                  }}
                >
                  {futPreviewJson
                    ? JSON.stringify(futPreviewJson, null, 2)
                    : futPositionsJson
                      ? JSON.stringify(futPositionsJson, null, 2)
                      : futBalanceJson
                        ? JSON.stringify(futBalanceJson, null, 2)
                        : futMarketJson
                          ? JSON.stringify(futMarketJson, null, 2)
                          : "// click Market / Balance / Positions / Preview"}
                </Box>
              </Box>
            </Stack>
          </CardContent>
        </Card>

        <Card sx={{ mb: 2 }}>
          <CardContent>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="h6" fontWeight={700}>
                Futures Flip Momentum (trailing long/short)
              </Typography>
              <Chip size="small" color="warning" variant="outlined" label="FUTURES" />
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Runs a server-side loop that flips LONG ⇄ SHORT based on peak/valley deltas. Use{" "}
              <b>Trailing (naked)</b> for raw momentum, or <b>Trailing (profit bound)</b> to require profit &gt; fees × multiple. Start with{" "}
              <b>preview</b> mode.
            </Typography>

            <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ mt: 2 }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                  <TextField label="Symbol" value={flipSymbol} onChange={(e) => setFlipSymbol(e.target.value)} size="small" fullWidth />
                  <TextField label="Contracts" value={flipContracts} onChange={(e) => setFlipContracts(e.target.value)} size="small" sx={{ minWidth: 140 }} />
                </Stack>

                {/* Row 1: deltas */}
                <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mt: 2 }}>
                  <TextField
                    label="Buy delta"
                    value={flipBuyDelta}
                    onChange={(e) => setFlipBuyDelta(e.target.value)}
                    size="small"
                    fullWidth
                  />
                  <TextField
                    label="Sell delta"
                    value={flipSellDelta}
                    onChange={(e) => setFlipSellDelta(e.target.value)}
                    size="small"
                    fullWidth
                  />
                  <TextField
                    label="Entry short delta"
                    value={flipEntryShortDelta}
                    onChange={(e) => setFlipEntryShortDelta(e.target.value)}
                    size="small"
                    fullWidth
                  />
                </Stack>

                {/* Row 2: fees + profit mode + live/preview */}
                <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mt: 2 }}>
                 
                  <FormControl size="small" sx={{ minWidth: 180 }}>
                    <InputLabel id="flip-profit-mode-label">Trailing mode</InputLabel>
                    <Select
                      labelId="flip-profit-mode-label"
                      value={flipProfitMode}
                      label="Trailing mode"
                      onChange={(e) => setFlipProfitMode(e.target.value as any)}
                    >
                      <MenuItem value="naked">Trailing (naked)</MenuItem>
                      <MenuItem value="profit-bound">Trailing (profit bound)</MenuItem>
                    </Select>
                  </FormControl>
                  <FormControl size="small" sx={{ minWidth: 160 }}>
                    <InputLabel id="flip-mode-label">Mode</InputLabel>
                    <Select labelId="flip-mode-label" value={flipMode} label="Mode" onChange={(e) => setFlipMode(e.target.value as any)}>
                      <MenuItem value="preview">preview</MenuItem>
                      <MenuItem value="live">live</MenuItem>
                    </Select>
                  </FormControl>
                </Stack>

                <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
                <TextField
                    label="Taker fee rate"
                    value={flipTakerFeeRate}
                    onChange={(e) => setFlipTakerFeeRate(e.target.value)}
                    size="small"
                    fullWidth
                  />
                  <TextField
                    label="$ per contract"
                    value={flipPerContractFeeUsd}
                    onChange={(e) => setFlipPerContractFeeUsd(e.target.value)}
                    size="small"
                    fullWidth
                  />
                  <TextField
                    label="Min profit multiple (fee gate)"
                    value={flipMinProfitMultiple}
                    onChange={(e) => setFlipMinProfitMultiple(e.target.value)}
                    size="small"
                    fullWidth
                    helperText="Only flip if profit > (fees × this). E.g., 1.5 = profit must be 1.5× fees. Loss-cutting always allowed."
                  />
                  {flipProfitMode === "profit-bound" && (
                    <TextField
                      label="Profit lock threshold (%)"
                      value={flipProfitLockThreshold}
                      onChange={(e) => setFlipProfitLockThreshold(e.target.value)}
                      size="small"
                      fullWidth
                      helperText="Once profitable by this %, flip thresholds lock to preserve it. E.g., 0.01 = 1% (flip-to-close never goes below entry)"
                    />
                  )}
                </Stack>

                <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: "wrap" }} useFlexGap>
                  <Button variant="contained" onClick={doFlipStart} disabled={!connected || flipStartLoading || futuresFlipStatus?.running}>
                    {flipStartLoading ? <CircularProgress size={20} /> : "Start Flip"}
                  </Button>
                  <Button variant="outlined" color="error" onClick={doFlipStop} disabled={!connected || flipStopLoading || !futuresFlipStatus?.running}>
                    {flipStopLoading ? <CircularProgress size={20} /> : "Stop Flip"}
                  </Button>
                </Stack>

                <Typography variant="body2" color="text.secondary" component="div" sx={{ mt: 2 }}>
                  Status: {futuresFlipStatus?.running ? "running" : "stopped"} · Position:{" "}
                  {futuresFlipStatus?.side === "flat" ? (
                    <Chip size="small" label="FLAT" color="default" variant="outlined" sx={{ ml: 0.5, mr: 0.5 }} />
                  ) : futuresFlipStatus?.side === "long" ? (
                    <Chip size="small" label="LONG (OPEN)" color="success" variant="filled" sx={{ ml: 0.5, mr: 0.5 }} />
                  ) : (
                    <Chip size="small" label="SHORT (OPEN)" color="error" variant="filled" sx={{ ml: 0.5, mr: 0.5 }} />
                  )}{" "}
                  · Last price: {futuresFlipStatus?.lastPrice != null ? Number(futuresFlipStatus.lastPrice).toFixed(2) : "—"}
                  {futuresFlipStatus?.side !== "flat" && futuresFlipStatus?.entryPrice != null && (
                    <> · Entry: {Number(futuresFlipStatus.entryPrice).toFixed(2)}</>
                  )}
                  <br />
                  Msg: {futuresFlipStatus?.lastMessage ?? "—"}
                  <br />
                  {futuresFlipStatus?.side === "flat" ? (
                    <>
                      <Typography component="span" fontWeight={600} color="info.main">
                        Next entry: Long at {futuresFlipStatus?.nextEntryToLong != null ? Number(futuresFlipStatus.nextEntryToLong).toFixed(2) : "—"} · Short at{" "}
                        {futuresFlipStatus?.nextEntryToShort != null ? Number(futuresFlipStatus.nextEntryToShort).toFixed(2) : "—"}
                      </Typography>
                    </>
                  ) : (
                    <>
                      <Typography component="span" fontWeight={600} color={futuresFlipStatus?.side === "long" ? "warning.main" : "info.main"}>
                        {futuresFlipStatus?.side === "long" ? "Next flip-to-short" : "Next flip-to-long"}:{" "}
                        {futuresFlipStatus?.side === "long" 
                          ? (futuresFlipStatus?.nextFlipToShort != null ? Number(futuresFlipStatus.nextFlipToShort).toFixed(2) : "—")
                          : (futuresFlipStatus?.nextFlipToLong != null ? Number(futuresFlipStatus.nextFlipToLong).toFixed(2) : "—")}
                      </Typography>
                      {futuresFlipStatus?.trailingStopPrice != null && (
                        <>
                          {" "}
                          · <Typography component="span" fontWeight={600} color="success.main">
                            Trailing stop: {Number(futuresFlipStatus.trailingStopPrice).toFixed(2)}
                          </Typography>
                        </>
                      )}
                    </>
                  )}
                  <br />
                  Est. net PnL:{" "}
                  {futuresFlipStatus?.estimatedNetPnl != null ? (
                    <Typography
                      component="span"
                      fontWeight={700}
                      color={futuresFlipStatus.estimatedNetPnl >= 0 ? "success.main" : "error.main"}
                    >
                      ${Number(futuresFlipStatus.estimatedNetPnl).toFixed(2)}
                    </Typography>
                  ) : futuresFlipStatus?.estimatedGrossPnl != null && futuresFlipStatus?.estimatedFlipFees != null ? (
                    <Typography
                      component="span"
                      fontWeight={700}
                      color={
                        futuresFlipStatus.estimatedGrossPnl - futuresFlipStatus.estimatedFlipFees >= 0
                          ? "success.main"
                          : "error.main"
                      }
                    >
                      ${(Number(futuresFlipStatus.estimatedGrossPnl) - Number(futuresFlipStatus.estimatedFlipFees)).toFixed(2)}
                    </Typography>
                  ) : (
                    "—"
                  )}
                  {futuresFlipStatus?.estimatedGrossPnl != null && (
                    <>
                      {" "}
                      · Est. gross PnL:{" "}
                      <Typography component="span" color="text.secondary">
                        ${Number(futuresFlipStatus.estimatedGrossPnl).toFixed(2)}
                      </Typography>
                    </>
                  )}
                  {futuresFlipStatus?.estimatedFlipFees != null && (
                    <>
                      {" "}
                      · Est. flip fees:{" "}
                      <Typography component="span" color="text.secondary">
                        ${Number(futuresFlipStatus.estimatedFlipFees).toFixed(2)}
                      </Typography>
                    </>
                  )}
                  {futuresFlipStatus?.leverage != null && (
                    <> · Leverage: {futuresFlipStatus.leverage}x</>
                  )}
                  {futuresFlipStatus?.requiredMargin != null && (
                    <> · Required margin: ${Number(futuresFlipStatus.requiredMargin).toFixed(2)}</>
                  )}
                  {futuresFlipStatus?.profitLocked && (
                    <>
                      {" "}
                      · <Chip size="small" label="PROFIT LOCKED" color="success" variant="filled" />
                      {futuresFlipStatus?.maxProfitAchieved != null && (
                        <>
                          {" "}
                          · High-water: {(Number(futuresFlipStatus.maxProfitAchieved) * 100).toFixed(2)}%
                        </>
                      )}
                      {futuresFlipStatus?.trailingStopPrice != null && (
                        <>
                          {" "}
                          · Trailing stop: {Number(futuresFlipStatus.trailingStopPrice).toFixed(2)}
                        </>
                      )}
                    </>
                  )}
                </Typography>
              </Box>

              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="subtitle2" color="text.secondary">
                  Flip status JSON
                </Typography>
                <Box
                  component="pre"
                  sx={{
                    mt: 1,
                    p: 1.5,
                    borderRadius: 1,
                    bgcolor: "rgba(255,255,255,0.06)",
                    maxWidth: "100%",
                    minWidth: 0,
                    overflowX: "auto",
                    maxHeight: 280,
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                    fontSize: 12,
                    lineHeight: 1.4,
                  }}
                >
                  {futuresFlipStatus ? JSON.stringify(futuresFlipStatus, null, 2) : "// start flip to see status"}
                </Box>
              </Box>
            </Stack>
          </CardContent>
        </Card>

        <Card sx={{ mb: 2 }}>
          <CardContent>
            <Stack direction={{ xs: "column", md: "row" }} spacing={2} alignItems={{ md: "center" }}>
              <Box sx={{ flex: 1 }}>
                <Typography variant="h6" fontWeight={700}>
                  Profit / Loss
                </Typography>
                <Typography variant="h4" fontWeight={800} sx={{ mt: 0.5 }}>
                  {money(stats.profit)}
                </Typography>
                <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
                  <Chip size="small" label={`Trades: ${stats.tradeCount}`} />
                  <Chip size="small" label={`Sells (realized): ${stats.sellCount}`} />
                  <Chip size="small" label={`Win rate: ${pct(stats.winRate)}`} />
                  <Chip size="small" label={`Avg/realized: ${money(stats.avg)}`} />
                </Stack>
              </Box>
              <Divider flexItem orientation="vertical" sx={{ display: { xs: "none", md: "block" } }} />
              <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                <DatePicker label="From" value={from} onChange={setFrom} />
                <DatePicker label="To" value={to} onChange={setTo} />
              </Stack>
            </Stack>
          </CardContent>
        </Card>

        <Card sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="h6" fontWeight={700} sx={{ mb: 1 }}>
              Cumulative Realized P/L (sell trades)
            </Typography>
            {chart.x.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No realized trades in this range yet (profit is emitted on filled sells).
              </Typography>
            ) : (
              <LineChart
                height={260}
                xAxis={[
                  {
                    data: chart.x,
                    scaleType: "time",
                    valueFormatter: (v) => dayjs(v).format("MMM D, HH:mm"),
                  },
                ]}
                series={[
                  {
                    data: chart.yGross,
                    label: "Gross P/L ($)",
                    valueFormatter: (v) => money(v as number),
                    color: "#1976d2",
                  },
                  {
                    data: chart.yNet,
                    label: "Net P/L ($)",
                    valueFormatter: (v) => money(v as number),
                    color: "#2e7d32",
                  },
                ]}
                grid={{ vertical: true, horizontal: true }}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
              <Typography variant="h6" fontWeight={700}>
                Trades
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Showing {rows.length} events
              </Typography>
            </Stack>

            <Box sx={{ overflowX: "auto" }}>
              <Table size="small" sx={{ minWidth: 900 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>Time</TableCell>
                    <TableCell>Symbol</TableCell>
                    <TableCell>Type</TableCell>
                    <TableCell>Action</TableCell>
                    <TableCell>Side</TableCell>
                    <TableCell align="right">Price</TableCell>
                    <TableCell align="right">Amount</TableCell>
                    <TableCell align="right">Net Profit</TableCell>
                    <TableCell>Source</TableCell>
                    <TableCell>Order</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={`${r.orderId}-${r.t}`}>
                      <TableCell>{dayjs(r.t).format("YYYY-MM-DD HH:mm:ss")}</TableCell>
                      <TableCell>{r.symbol}</TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          label={r.instrument.toUpperCase()}
                          color={r.instrument === "futures" ? "warning" : "info"}
                          variant="outlined"
                        />
                      </TableCell>
                      <TableCell>
                        {r.positionAction ? (
                          <Chip
                            size="small"
                            label={r.positionAction.toUpperCase()}
                            color={r.positionAction === "open" ? "success" : "error"}
                            variant="filled"
                          />
                        ) : (
                          <Typography variant="body2" color="text.secondary">
                            —
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          label={r.side.toUpperCase()}
                          color={r.side === "buy" ? "info" : "warning"}
                          variant="outlined"
                        />
                      </TableCell>
                      <TableCell align="right">{r.price.toFixed(2)}</TableCell>
                      <TableCell align="right">{r.amount.toFixed(8)}</TableCell>
                      <TableCell align="right">
                        {typeof r.netProfitQuote === "number" ? (
                          <Typography
                            component="span"
                            fontWeight={700}
                            color={r.netProfitQuote >= 0 ? "success.main" : "error.main"}
                          >
                            {money(r.netProfitQuote)}
                          </Typography>
                        ) : typeof r.profitQuote === "number" ? (
                          <Typography
                            component="span"
                            fontWeight={700}
                            color={r.profitQuote >= 0 ? "success.main" : "error.main"}
                          >
                            {money(r.profitQuote)}
                          </Typography>
                        ) : (
                          <Typography component="span" color="text.secondary">
                            —
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>{r.source}</TableCell>
                      <TableCell sx={{ fontFamily: "monospace" }}>{r.orderId}</TableCell>
                    </TableRow>
                  ))}
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={10}>
                        <Typography variant="body2" color="text.secondary">
                          No trades yet. Start the bot server + strategy, then keep this page open.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Box>
          </CardContent>
        </Card>
      </Box>
    </LocalizationProvider>
  );
}


