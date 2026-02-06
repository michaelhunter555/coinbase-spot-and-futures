import ccxt from "ccxt";
import crypto from "node:crypto";

export type FuturesOrderType = "market" | "limit";
export type FuturesSide = "buy" | "sell";

export type FuturesOrderRequest = {
  symbol: string; // unified CCXT future symbol, e.g. ETH/USD:USD-301220
  type: FuturesOrderType;
  side: FuturesSide; // buy=open long, sell=open short (for futures)
  contracts: number; // integer contracts
  price?: number; // required for limit
  retail_portfolio_id?: string;
  marginMode?: "cross" | "isolated";
  leverage?: number;
};

export function createCoinbaseAdvanced(opts: { apiKey: string; secret: string }) {
  const ExchangeCtor = (ccxt as any)["coinbaseadvanced"];
  if (typeof ExchangeCtor !== "function") throw new Error("CCXT exchange not found: coinbaseadvanced");
  return new ExchangeCtor({
    apiKey: opts.apiKey,
    secret: opts.secret,
    enableRateLimit: true,
    timeout: 30_000,
  });
}

export async function getFuturesMarket(opts: { apiKey: string; secret: string; symbol: string }) {
  const ex = createCoinbaseAdvanced({ apiKey: opts.apiKey, secret: opts.secret });
  try {
    await ex.loadMarkets();
    const market = ex.market(opts.symbol);
    return { market };
  } finally {
    try {
      await ex.close?.();
    } catch {
      // ignore
    }
  }
}

export async function getFuturesBalanceSummary(opts: { apiKey: string; secret: string }) {
  const ex = createCoinbaseAdvanced({ apiKey: opts.apiKey, secret: opts.secret });
  try {
    // CCXT coinbase implements CFM summary under fetchBalance({ type: 'future' })
    const balance = await ex.fetchBalance({ type: "future" });
    const lastJson = (ex as any).last_json_response;
    const lastHttpResponse = (ex as any).last_http_response;
    return { balance, lastJson, lastHttpResponse };
  } finally {
    try {
      await ex.close?.();
    } catch {
      // ignore
    }
  }
}

export async function getFuturesPositions(opts: { apiKey: string; secret: string; symbols?: string[] }) {
  const ex = createCoinbaseAdvanced({ apiKey: opts.apiKey, secret: opts.secret });
  try {
    const positions = await ex.fetchPositions(opts.symbols, { type: "future" });
    return { positions };
  } finally {
    try {
      await ex.close?.();
    } catch {
      // ignore
    }
  }
}

export async function previewFuturesOrder(opts: { apiKey: string; secret: string; req: FuturesOrderRequest }) {
  const ex = createCoinbaseAdvanced({ apiKey: opts.apiKey, secret: opts.secret });
  try {
    await ex.loadMarkets();
    const market = ex.market(opts.req.symbol);

    const params: any = { preview: true };
    if (opts.req.retail_portfolio_id) params.retail_portfolio_id = opts.req.retail_portfolio_id;
    if (opts.req.marginMode) params.marginMode = opts.req.marginMode;
    if (opts.req.leverage && Number.isFinite(opts.req.leverage)) params.leverage = opts.req.leverage;

    const order = await ex.createOrder(
      opts.req.symbol,
      opts.req.type,
      opts.req.side,
      opts.req.contracts,
      opts.req.type === "limit" ? opts.req.price : undefined,
      params,
    );

    return {
      market,
      order,
      lastRequestUrl: (ex as any).last_request_url,
      lastRequestBody: (ex as any).last_request_body,
      lastJson: (ex as any).last_json_response,
      lastHttpResponse: (ex as any).last_http_response,
    };
  } finally {
    try {
      await ex.close?.();
    } catch {
      // ignore
    }
  }
}

export async function placeFuturesOrder(opts: { apiKey: string; secret: string; req: FuturesOrderRequest }) {
  const ex = createCoinbaseAdvanced({ apiKey: opts.apiKey, secret: opts.secret });
  try {
    await ex.loadMarkets();

    const params: any = {};
    if (opts.req.retail_portfolio_id) params.retail_portfolio_id = opts.req.retail_portfolio_id;
    if (opts.req.marginMode) params.marginMode = opts.req.marginMode;
    if (opts.req.leverage && Number.isFinite(opts.req.leverage)) params.leverage = opts.req.leverage;

    const order = await ex.createOrder(
      opts.req.symbol,
      opts.req.type,
      opts.req.side,
      opts.req.contracts,
      opts.req.type === "limit" ? opts.req.price : undefined,
      params,
    );

    return {
      order,
      lastRequestUrl: (ex as any).last_request_url,
      lastRequestBody: (ex as any).last_request_body,
      lastJson: (ex as any).last_json_response,
      lastHttpResponse: (ex as any).last_http_response,
    };
  } finally {
    try {
      await ex.close?.();
    } catch {
      // ignore
    }
  }
}

export async function closeFuturesPosition(opts: {
  apiKey: string;
  secret: string;
  symbol: string;
  sizeContracts?: number;
}) {
  const ex = createCoinbaseAdvanced({ apiKey: opts.apiKey, secret: opts.secret });
  try {
    await ex.loadMarkets();
    const clientOrderId = crypto.randomUUID();
    const params: any = { clientOrderId };
    if (opts.sizeContracts != null) params.size = opts.sizeContracts;
    const order = await ex.closePosition(opts.symbol, undefined, params);
    return { order, clientOrderId };
  } finally {
    try {
      await ex.close?.();
    } catch {
      // ignore
    }
  }
}


