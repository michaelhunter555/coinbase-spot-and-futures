import ccxt from "ccxt";

type MarketSummary = {
  exchangeId: string;
  ok: boolean;
  error?: string;
  totalMarkets?: number;
  derivativeCount?: number;
  perpetualSwapCount?: number;
  perpLikeCount?: number;
  sampleDerivatives?: Array<{ symbol: string; type?: string; swap?: boolean; future?: boolean }>;
  samplePerpetualSwaps?: Array<{ symbol: string; type?: string; swap?: boolean }>;
};

function isPerpLikeSymbol(symbol: string) {
  const s = symbol.toUpperCase();
  return s.includes("PERP") || s.includes("SWAP");
}

function safeMarketType(m: any): string | undefined {
  return typeof m?.type === "string" ? m.type : undefined;
}

function isPerpetualSwap(m: any): boolean {
  // In CCXT, perpetual swaps usually have swap=true and no expiry
  if (m?.swap !== true) return false;
  if (m?.expiry !== undefined && m?.expiry !== null) return false;
  if (m?.future === true) return false;
  return true;
}

export async function probeDerivativeMarkets(opts?: {
  preferredExchangeIds?: string[];
}): Promise<MarketSummary[]> {
  const preferred = opts?.preferredExchangeIds ?? [
    "coinbase",
    "coinbaseinternational",
    "coinbasepro",
  ];

  // Try preferred list first, then fall back to any exchange ids containing "coinbase"
  const ids = new Set<string>();
  for (const id of preferred) ids.add(id);
  for (const id of (ccxt as any).exchanges as string[]) {
    if (id.toLowerCase().includes("coinbase")) ids.add(id);
  }

  const results: MarketSummary[] = [];

  for (const exchangeId of ids) {
    const ExchangeCtor = (ccxt as any)[exchangeId];
    if (typeof ExchangeCtor !== "function") continue;

    const ex = new ExchangeCtor({
      enableRateLimit: true,
      timeout: 30_000,
    });

    try {
      const markets = await ex.loadMarkets();
      const list = Object.values(markets ?? {});

      const derivatives = list.filter((m: any) => m?.swap === true || m?.future === true);
      const perpetualSwaps = list.filter((m: any) => isPerpetualSwap(m));
      const perpLike = list.filter((m: any) => typeof m?.symbol === "string" && isPerpLikeSymbol(m.symbol));

      const sampleDerivatives = derivatives.slice(0, 15).map((m: any) => {
        const t = safeMarketType(m);
        return {
          symbol: String(m.symbol),
          ...(t !== undefined ? { type: t } : {}),
          ...(m.swap === true ? { swap: true } : {}),
          ...(m.future === true ? { future: true } : {}),
        };
      });

      const samplePerpetualSwaps = perpetualSwaps.slice(0, 15).map((m: any) => {
        const t = safeMarketType(m);
        return {
          symbol: String(m.symbol),
          ...(t !== undefined ? { type: t } : {}),
          swap: true,
        };
      });

      results.push({
        exchangeId,
        ok: true,
        totalMarkets: list.length,
        derivativeCount: derivatives.length,
        perpetualSwapCount: perpetualSwaps.length,
        perpLikeCount: perpLike.length,
        sampleDerivatives,
        samplePerpetualSwaps,
      });
    } catch (e: any) {
      results.push({
        exchangeId,
        ok: false,
        error: e?.message ?? String(e),
      });
    } finally {
      try {
        await ex.close?.();
      } catch {
        // ignore
      }
    }
  }

  // Sort: derivative-capable first
  results.sort((a, b) => (b.derivativeCount ?? 0) - (a.derivativeCount ?? 0));
  return results;
}


