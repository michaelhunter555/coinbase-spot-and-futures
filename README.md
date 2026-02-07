# Coinbase Trading Bot

A cryptocurrency trading bot for Coinbase Advanced Trade with support for spot and futures trading strategies. Features a real-time web dashboard for monitoring trades, positions, and P/L.

## Features

- **Spot Momentum Trading**: Automated momentum-based spot trading with configurable deltas
- **Futures Flip Momentum**: Long/short futures strategy that flips positions based on momentum
- **Futures Directional Momentum**: Single-leg long or short futures positions with trailing stops
- **Real-time Dashboard**: Live trade monitoring, P/L tracking, and position management
- **Paper Trading**: Safe testing mode before going live
- **Profit Protection**: High-water mark trailing stops and fee-aware profit locking
- **Fee Calculation**: Accurate net P/L calculations including Coinbase trading fees

## Prerequisites

- Node.js 18+ and npm
- MongoDB database (local or cloud)
- Coinbase Advanced Trade API credentials
- Coinbase account with Advanced Trade enabled

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd coinbase-bot
```

2. Install server dependencies:
```bash
cd coinbase-bot-server
npm install
```

3. Install client dependencies:
```bash
cd ../coinbase-bot
npm install
```

## Environment Variables

### Server (`coinbase-bot-server`)

Create a `.env` file in the root directory (`/coinbase-bot/`) or in `coinbase-bot-server/`. The server will automatically find `.env` files in parent directories.

#### Required Variables

```bash
# Server Configuration
PORT=3001

# Coinbase API Credentials
COINBASE_API_KEY=your_api_key_here
COINBASE_API_SECRET=your_api_secret_here

# Database
MONGO_DB_URI=mongodb://localhost:27017/coinbase-bot
# Or for MongoDB Atlas:
# MONGO_DB_URI=mongodb+srv://username:password@cluster.mongodb.net/coinbase-bot
```

#### Optional Variables

```bash
# Trading Mode (default: paper)
TRADING_MODE=paper  # or "live" for real trading

# Default Product (default: BTC/USD)
PRODUCT=BTC/USD  # Also accepts BTC-USD format

# Strategy Configuration (default: momentum)
STRATEGY=momentum

# Momentum Tuning
BUY_POSITION_DELTA=0.015      # 1.5% price increase to enter long
SELL_POSITION_DELTA=0.02      # 2% price decrease to exit long
ORDER_PRICE_DELTA=0.001       # 0.1% price adjustment for orders
STOP_LOSS_DELTA=              # Optional: stop loss percentage (disabled if not set)

# Risk Management
QUOTE_BALANCE_MINIMUM=0.06    # Minimum balance required (USD)
MAX_QUOTE_TO_SPEND=25         # Maximum amount to spend per trade (USD)
```

### Client (`coinbase-bot`)

Create a `.env.local` file in the `coinbase-bot/` directory.

#### Optional Variables

```bash
# Socket.IO Server URL (default: http://localhost:3001)
# If not set, the client will attempt to connect to http://localhost:3001
NEXT_PUBLIC_SOCKET_IO=http://localhost:3001
```

## Running the Application

### Development Mode

1. **Start the server** (from `coinbase-bot-server/`):
```bash
npm run dev
```

The server will start on `http://localhost:3001` (or your configured `PORT`).

2. **Start the client** (from `coinbase-bot/`):
```bash
npm run dev
```

The client will start on `http://localhost:3000`.

3. **Open your browser**:
Navigate to `http://localhost:3000` to access the trading dashboard.

### Production Mode

1. **Build the client**:
```bash
cd coinbase-bot
npm run build
```

2. **Start the server**:
```bash
cd coinbase-bot-server
npm start
```

3. **Start the client**:
```bash
cd coinbase-bot
npm start
```

## Project Structure

```
coinbase-bot/
├── coinbase-bot-server/      # Backend server (Express + Socket.IO)
│   ├── src/
│   │   ├── futures/          # Futures trading strategies
│   │   ├── runner/           # Strategy runner
│   │   ├── exchange/         # Coinbase API integration
│   │   └── db/               # MongoDB models and controllers
│   ├── app.ts                # Main server entry point
│   └── package.json
│
├── coinbase-bot/             # Frontend client (Next.js)
│   ├── components/           # React components
│   ├── contexts/             # React contexts (TradesContext)
│   ├── app/                  # Next.js app directory
│   └── package.json
│
└── README.md                 # This file
```

## API Endpoints

### Health Check
- `GET /health` - Server health status

### Spot Trading
- `GET /status` - Get current strategy status
- `POST /start` - Start spot momentum strategy
- `POST /stop` - Stop spot momentum strategy

### Futures Trading
- `GET /futures/flip/status` - Get futures flip momentum status
- `POST /futures/flip/start` - Start futures flip momentum
- `POST /futures/flip/stop` - Stop futures flip momentum
- `GET /futures/momentum/status` - Get directional momentum status
- `POST /futures/momentum/start` - Start directional momentum
- `POST /futures/momentum/stop` - Stop directional momentum

### Debug/Info
- `GET /debug/markets` - Probe derivative markets
- `GET /debug/portfolios` - Fetch Coinbase portfolios
- `POST /debug/order-preview` - Preview order without executing

## Socket.IO Events

The server broadcasts real-time updates via Socket.IO:

- `status` - Spot strategy status updates
- `futuresFlipStatus` - Futures flip momentum status
- `futuresMomentumStatus` - Directional momentum status
- `trade` - Trade execution events

## Safety & Risk Management

⚠️ **IMPORTANT**: 

- **Default mode is paper trading** - No real trades will execute unless `TRADING_MODE=live` is set
- Always test strategies in paper mode first
- Start with small position sizes
- Monitor your positions closely
- Understand leverage risks (futures trading uses 10x intraday, 4x overnight)
- Fees are significant with leverage - ensure your profit targets account for fees

## Coinbase API Setup

1. Log in to [Coinbase Advanced Trade](https://advancedtrade.coinbase.com)
2. Navigate to **Settings** → **API**
3. Create a new API key with the following permissions:
   - **View** (required)
   - **Trade** (required for live trading)
4. Copy your API key and secret
5. Add them to your `.env` file

**Note**: For futures trading, ensure your account has futures trading enabled and sufficient margin.

## Troubleshooting

### Server won't start
- Check that MongoDB is running and `MONGO_DB_URI` is correct
- Verify `COINBASE_API_KEY` and `COINBASE_API_SECRET` are set
- Ensure `PORT` is not already in use

### Client can't connect to server
- Verify the server is running on the correct port
- Check `NEXT_PUBLIC_SOCKET_IO` matches your server URL
- Check browser console for connection errors

### "Insufficient funds" errors
- Verify your account balance
- Check `MAX_QUOTE_TO_SPEND` is not too high
- For futures: ensure you have enough margin (account for leverage)

### Trades not executing
- Verify `TRADING_MODE` is set to `live` (if you want real trades)
- Check API key has "Trade" permission
- Review server logs for error messages

## License

ISC

## Support

For issues and questions, please check the codebase or create an issue in the repository.

