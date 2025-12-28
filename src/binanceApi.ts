import axios from 'axios';
import { debug, error, info, warn } from './logger.js';

const BINANCE_API_BASE = 'https://api.binance.com/api/v3';
const COINGECKO_API_BASE = 'https://api.coingecko.com/api/v3';

// CoinGecko IDs for our assets
const ASSET_TO_COINGECKO: Record<string, string> = {
  btc: 'bitcoin',
  eth: 'ethereum',
  xrp: 'ripple',
  sol: 'solana',
};

/**
 * IMPORTANT: Polymarket uses different price sources for different market types:
 *
 * Resolution Sources (based on market descriptions):
 * ------------------------------------------------
 * BTC Markets:
 *   - 15m: Chainlink BTC/USD (https://data.chain.link/streams/btc-usd)
 *   - 1h/4h/1d: Binance BTC/USDT (https://www.binance.com/en/trade/BTC_USDT)
 *
 * ETH Markets:
 *   - 15m: Chainlink ETH/USD
 *   - 4h: Chainlink ETH/USD (https://data.chain.link/streams/eth-usd)
 *   - 1d: TBD (check market description)
 *
 * XRP/SOL Markets:
 *   - 15m: Chainlink streams (XRP/USD, SOL/USD)
 *   - 1h+: Check market descriptions
 *
 * NOTE: We use Binance as an approximation for all since:
 * 1. Chainlink Data Streams require a paid subscription
 * 2. Binance prices are typically within 0.1% of Chainlink
 * 3. For arbitrage, we need the price difference to be larger than trading costs anyway
 *
 * RISK: There's oracle risk if Binance and Chainlink diverge significantly.
 * The profit zone calculation should account for this potential discrepancy.
 */

// Map our asset names to Binance symbols
const ASSET_TO_SYMBOL: Record<string, string> = {
  btc: 'BTCUSDT',
  eth: 'ETHUSDT',
  xrp: 'XRPUSDT',
  sol: 'SOLUSDT',
};

// Binance kline intervals
type BinanceInterval = '15m' | '30m' | '1h' | '4h' | '1d';

interface BinanceKline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

/**
 * Fetch the current price for an asset from CoinGecko (works globally, no geo-restrictions)
 */
export async function getCurrentPriceFromCoinGecko(asset: string): Promise<number | null> {
  const coinId = ASSET_TO_COINGECKO[asset.toLowerCase()];
  if (!coinId) {
    debug(`Unknown asset for CoinGecko: ${asset}`);
    return null;
  }

  try {
    const response = await axios.get(`${COINGECKO_API_BASE}/simple/price`, {
      params: {
        ids: coinId,
        vs_currencies: 'usd',
      },
      timeout: 10000,
    });

    return response.data[coinId]?.usd ?? null;
  } catch (err) {
    debug(`Failed to fetch CoinGecko price for ${coinId}`);
    return null;
  }
}

/**
 * Fetch the current price for an asset from Binance
 * Falls back to CoinGecko if Binance is unavailable (geo-restricted)
 */
export async function getCurrentPrice(asset: string): Promise<number | null> {
  const symbol = ASSET_TO_SYMBOL[asset.toLowerCase()];
  if (!symbol) {
    debug(`Unknown asset for Binance: ${asset}`);
    return getCurrentPriceFromCoinGecko(asset);
  }

  try {
    const response = await axios.get(`${BINANCE_API_BASE}/ticker/price`, {
      params: { symbol },
      timeout: 5000,
    });

    return parseFloat(response.data.price);
  } catch (err: unknown) {
    // Check for geo-restriction (HTTP 451)
    const axiosErr = err as { response?: { status?: number } };
    if (axiosErr?.response?.status === 451) {
      debug(`Binance geo-restricted, falling back to CoinGecko for ${asset}`);
      return getCurrentPriceFromCoinGecko(asset);
    }
    error(`Failed to fetch Binance price for ${symbol}`, err);
    return getCurrentPriceFromCoinGecko(asset);
  }
}

// Track if Binance is geo-restricted (cache the result)
let binanceBlocked = false;

/**
 * Fetch a specific kline (candle) from Binance
 *
 * @param asset - Asset name (btc, eth, xrp, sol)
 * @param interval - Candle interval (15m, 1h, 4h, 1d)
 * @param openTime - The open time of the candle (milliseconds)
 */
export async function getKline(
  asset: string,
  interval: BinanceInterval,
  openTime: number
): Promise<BinanceKline | null> {
  // Skip if we know Binance is blocked
  if (binanceBlocked) {
    return null;
  }

  const symbol = ASSET_TO_SYMBOL[asset.toLowerCase()];
  if (!symbol) {
    debug(`Unknown asset for Binance: ${asset}`);
    return null;
  }

  try {
    const response = await axios.get(`${BINANCE_API_BASE}/klines`, {
      params: {
        symbol,
        interval,
        startTime: openTime,
        limit: 1,
      },
      timeout: 5000,
    });

    if (response.data.length === 0) {
      return null;
    }

    const kline = response.data[0];
    return {
      openTime: kline[0],
      open: parseFloat(kline[1]),
      high: parseFloat(kline[2]),
      low: parseFloat(kline[3]),
      close: parseFloat(kline[4]),
      volume: parseFloat(kline[5]),
      closeTime: kline[6],
    };
  } catch (err: unknown) {
    // Check for geo-restriction (HTTP 451)
    const axiosErr = err as { response?: { status?: number } };
    if (axiosErr?.response?.status === 451) {
      if (!binanceBlocked) {
        warn('Binance API is geo-restricted from your location. Using CoinGecko for current prices.');
        binanceBlocked = true;
      }
      return null;
    }
    debug(`Failed to fetch Binance kline for ${symbol} ${interval}`);
    return null;
  }
}

/**
 * Fetch the open price for a candle that started at a specific time
 * This is the reference price that Polymarket uses for up/down resolution
 *
 * If Binance is unavailable, falls back to CoinGecko current price
 * (less accurate for historical candles, but better than nothing)
 */
export async function getCandleOpenPrice(
  asset: string,
  interval: BinanceInterval,
  candleStartTime: Date
): Promise<number | null> {
  // Try Binance first for accurate historical OHLC data
  const kline = await getKline(asset, interval, candleStartTime.getTime());
  if (kline?.open) {
    return kline.open;
  }

  // Fallback: If the candle just started (within 5 minutes), current price is close enough
  const now = Date.now();
  const candleAge = now - candleStartTime.getTime();
  const fiveMinutes = 5 * 60 * 1000;

  if (candleAge <= fiveMinutes) {
    debug(`Candle just started, using current CoinGecko price for ${asset}`);
    return getCurrentPriceFromCoinGecko(asset);
  }

  // For older candles, we can't get accurate open price from CoinGecko
  // Return null - cross-market detection will skip this market
  debug(`Cannot fetch historical open price for ${asset} ${interval} candle from ${candleStartTime.toISOString()}`);
  return null;
}

/**
 * Calculate the start time of the current candle for a given interval
 */
export function getCurrentCandleStartTime(interval: BinanceInterval): Date {
  const now = new Date();

  switch (interval) {
    case '15m': {
      const mins = Math.floor(now.getUTCMinutes() / 15) * 15;
      now.setUTCMinutes(mins, 0, 0);
      break;
    }
    case '30m': {
      const mins = Math.floor(now.getUTCMinutes() / 30) * 30;
      now.setUTCMinutes(mins, 0, 0);
      break;
    }
    case '1h': {
      now.setUTCMinutes(0, 0, 0);
      break;
    }
    case '4h': {
      const hours = Math.floor(now.getUTCHours() / 4) * 4;
      now.setUTCHours(hours, 0, 0, 0);
      break;
    }
    case '1d': {
      now.setUTCHours(0, 0, 0, 0);
      break;
    }
  }

  return now;
}

/**
 * Get the open prices for all active candles of an asset
 * Returns a map of candleStartTime -> openPrice
 */
export async function getActiveCandelOpenPrices(
  asset: string,
  intervals: BinanceInterval[] = ['15m', '1h', '4h', '1d']
): Promise<Map<string, { interval: BinanceInterval; openTime: Date; openPrice: number }>> {
  const prices = new Map<string, { interval: BinanceInterval; openTime: Date; openPrice: number }>();

  for (const interval of intervals) {
    const startTime = getCurrentCandleStartTime(interval);
    const openPrice = await getCandleOpenPrice(asset, interval, startTime);

    if (openPrice !== null) {
      const key = `${asset}-${interval}-${startTime.getTime()}`;
      prices.set(key, {
        interval,
        openTime: startTime,
        openPrice,
      });
      debug(`${asset.toUpperCase()} ${interval} candle started at ${startTime.toISOString()}: $${openPrice.toFixed(2)}`);
    }
  }

  return prices;
}

/**
 * Fetch open prices for all supported assets
 */
export async function getAllCandleOpenPrices(
  assets: string[] = ['btc', 'eth', 'xrp', 'sol'],
  intervals: BinanceInterval[] = ['15m', '1h', '4h', '1d']
): Promise<Map<string, number>> {
  const allPrices = new Map<string, number>();

  info(`Fetching Binance candle open prices for ${assets.length} assets...`);

  for (const asset of assets) {
    const assetPrices = await getActiveCandelOpenPrices(asset, intervals);
    for (const [key, data] of assetPrices) {
      allPrices.set(key, data.openPrice);
    }
  }

  info(`Loaded ${allPrices.size} candle open prices from Binance`);
  return allPrices;
}

/**
 * Calculate the candle start time for a market based on its end time and interval
 *
 * For Polymarket up/down markets:
 * - 15m market ending at 10:30 started at 10:15
 * - 1h market ending at 11:00 started at 10:00
 * - 4h market ending at 16:00 started at 12:00
 * - 1d market ending at midnight tomorrow started at midnight today
 */
export function calculateCandleStartTime(endTime: Date, interval: BinanceInterval): Date {
  const startTime = new Date(endTime);

  switch (interval) {
    case '15m':
      startTime.setTime(startTime.getTime() - 15 * 60 * 1000);
      break;
    case '30m':
      startTime.setTime(startTime.getTime() - 30 * 60 * 1000);
      break;
    case '1h':
      startTime.setTime(startTime.getTime() - 60 * 60 * 1000);
      break;
    case '4h':
      startTime.setTime(startTime.getTime() - 4 * 60 * 60 * 1000);
      break;
    case '1d':
      startTime.setTime(startTime.getTime() - 24 * 60 * 60 * 1000);
      break;
  }

  return startTime;
}

/**
 * Get the open price for a specific market based on its end time
 */
export async function getMarketOpenPrice(
  asset: string,
  interval: BinanceInterval,
  marketEndTime: Date
): Promise<number | null> {
  const candleStartTime = calculateCandleStartTime(marketEndTime, interval);
  return getCandleOpenPrice(asset, interval, candleStartTime);
}
