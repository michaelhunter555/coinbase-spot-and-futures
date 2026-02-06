"use client";

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

export type TradeEvent = {
  ts: string;
  strategy: string;
  exchange: string;
  mode: "paper" | "live";
  symbol: string;
  side: "buy" | "sell";
  price: number;
  amount: number;
  orderId: string;
  profitQuote?: number;
  netProfitQuote?: number;
  positionAction?: "open" | "close";
};

export type RunnerStatus = {
  running: boolean;
  strategy: string | null;
  product: string | null;
  mode: "paper" | "live" | null;
  exchange: string | null;
  lastPrice: number | null;
  lastMessage: string | null;
  positionExists: boolean;
  nextTargetBuyPrice?: number;
  nextTargetSellPrice?: number;
  status: "stopped" | "running" | "error";
};

export type TradesContextValue = {
  connected: boolean;
  socketUrl: string | null;
  trades: TradeEvent[];
  lastTrade: TradeEvent | null;
  serverStatus: RunnerStatus | null;
  futuresFlipStatus: any | null;
  futuresMomentumStatus: any | null;
};

const TradesContext = createContext<TradesContextValue | null>(null);

export function TradesProvider({ children }: { children: React.ReactNode }) {
  const socketUrl = process.env.NEXT_PUBLIC_SOCKET_IO ?? null;
  const [connected, setConnected] = useState(false);
  const [trades, setTrades] = useState<TradeEvent[]>([]);
  const [serverStatus, setServerStatus] = useState<RunnerStatus | null>(null);
  const [futuresFlipStatus, setFuturesFlipStatus] = useState<any | null>(null);
  const [futuresMomentumStatus, setFuturesMomentumStatus] = useState<any | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!socketUrl) return;

    const socket = io(socketUrl, {
      transports: ["websocket"],
      reconnection: true,
    });
    socketRef.current = socket;

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onTrade = (trade: TradeEvent) => {
      setTrades((prev) => [trade, ...prev].slice(0, 200));
    };
    const onStatus = (s: RunnerStatus) => setServerStatus(s);
    const onFuturesFlipStatus = (s: any) => setFuturesFlipStatus(s);
    const onFuturesMomentumStatus = (s: any) => setFuturesMomentumStatus(s);

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("trade", onTrade);
    socket.on("status", onStatus);
    socket.on("futuresFlipStatus", onFuturesFlipStatus);
    socket.on("futuresMomentumStatus", onFuturesMomentumStatus);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("trade", onTrade);
      socket.off("status", onStatus);
      socket.off("futuresFlipStatus", onFuturesFlipStatus);
      socket.off("futuresMomentumStatus", onFuturesMomentumStatus);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [socketUrl]);

  const value = useMemo<TradesContextValue>(() => {
    return {
      connected,
      socketUrl,
      trades,
      lastTrade: trades[0] ?? null,
      serverStatus,
      futuresFlipStatus,
      futuresMomentumStatus,
    };
  }, [connected, socketUrl, trades, serverStatus, futuresFlipStatus, futuresMomentumStatus]);

  return <TradesContext.Provider value={value}>{children}</TradesContext.Provider>;
}

export function useTrades() {
  const ctx = useContext(TradesContext);
  if (!ctx) throw new Error("useTrades must be used within TradesProvider");
  return ctx;
}


