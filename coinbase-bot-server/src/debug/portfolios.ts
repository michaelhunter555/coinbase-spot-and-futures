import ccxt from "ccxt";

export async function fetchAdvancedPortfolios(opts: { apiKey: string; secret: string }) {
  const ExchangeCtor = (ccxt as any)["coinbaseadvanced"];
  if (typeof ExchangeCtor !== "function") throw new Error("CCXT exchange not found: coinbaseadvanced");

  const ex = new ExchangeCtor({
    apiKey: opts.apiKey,
    secret: opts.secret,
    enableRateLimit: true,
    timeout: 30_000,
  });

  try {
    const portfolios = await ex.fetchPortfolios();
    return portfolios;
  } finally {
    try {
      await ex.close?.();
    } catch {
      // ignore
    }
  }
}


