import ccxt from "ccxt";

export type OrderPreviewRequest = {
  exchangeId: "coinbaseadvanced";
  symbol: string;
  type: "market" | "limit";
  side: "buy" | "sell";
  amount: number;
  price?: number;
  retail_portfolio_id?: string;
  leverage?: number;
  marginMode?: "cross" | "isolated";
};

export async function previewOrder(opts: {
  apiKey: string;
  secret: string;
  req: OrderPreviewRequest;
}) {
  const ExchangeCtor = (ccxt as any)[opts.req.exchangeId];
  if (typeof ExchangeCtor !== "function") throw new Error(`CCXT exchange not found: ${opts.req.exchangeId}`);

  const ex = new ExchangeCtor({
    apiKey: opts.apiKey,
    secret: opts.secret,
    enableRateLimit: true,
    timeout: 30_000,
  });

  try {
    await ex.loadMarkets();
    const market = ex.market(opts.req.symbol);

    const params: any = { preview: true };
    if (opts.req.retail_portfolio_id) params.retail_portfolio_id = opts.req.retail_portfolio_id;
    if (opts.req.leverage && Number.isFinite(opts.req.leverage)) params.leverage = opts.req.leverage;
    if (opts.req.marginMode) params.marginMode = opts.req.marginMode;

    const order = await ex.createOrder(
      opts.req.symbol,
      opts.req.type,
      opts.req.side,
      opts.req.amount,
      opts.req.type === "limit" ? opts.req.price : undefined,
      params,
    );

    // CCXT preview responses can be hard to interpret because the exchange may return
    // minimal `success_response` fields for some derivatives products.
    // Expose the raw last JSON response so we can see the actual preview payload.
    const lastJson = (ex as any).last_json_response;
    const lastHttpResponse = (ex as any).last_http_response; // usually string
    const lastRequestUrl = (ex as any).last_request_url;
    const lastRequestBody = (ex as any).last_request_body;

    return {
      market,
      order,
      lastRequestUrl,
      lastRequestBody,
      lastJson,
      lastHttpResponse,
    };
  } finally {
    try {
      await ex.close?.();
    } catch {
      // ignore
    }
  }
}


