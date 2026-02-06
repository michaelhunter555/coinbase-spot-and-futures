## Coinbase bot server (strategy runner)

This folder is the backend bot runner. It’s modeled after the old CrypFinder flow:

- **price feed** (polling ticker)
- **momentum loops** (gain position / lose position)
- **order placement + polling** (cancel after timeout)
- **position persistence** (resume after restart)

### Required environment variables

- **`PORT`**: HTTP port for the server
- **`COINBASE_API_KEY`**
- **`COINBASE_API_SECRET`**

> Note: This repo does **not** include a checked-in `.env` file. Set env vars in your shell or create your own local `.env`.

### Optional environment variables (safe defaults)

- **`TRADING_MODE`**: `paper` (default) or `live`
- **`STRATEGY`**: `momentum` (default)
- **`PRODUCT`**: `BTC/USD` (default). Also accepts `BTC-USD`.

Momentum tuning:

- **`BUY_POSITION_DELTA`** (default `0.015`)
- **`SELL_POSITION_DELTA`** (default `0.02`)
- **`ORDER_PRICE_DELTA`** (default `0.001`)
- **`STOP_LOSS_DELTA`** (default unset/disabled unless provided)

Risk:

- **`QUOTE_BALANCE_MINIMUM`** (default `0.06`)
- **`MAX_QUOTE_TO_SPEND`** (default `25`)

### Run it

From `coinbase-bot-server/`:

```bash
npm run dev
```

Then:

- `GET /health`
- `POST /start` with body like:

```json
{
  "product": "BTC/USD",
  "mode": "paper"
}
```

### Safety

The default mode is **paper trading**. To enable real trading, set `TRADING_MODE=live` and use `POST /start` with `"mode":"live"`.


