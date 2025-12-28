import axios from 'axios';
import { debug, error, info, warn } from './logger.js';

const POLYMARKET_API_BASE = 'https://polymarket.com/api/crypto';

/**
 * Polymarket's own price API provides the exact reference prices used for market resolution.
 *
 * This is MUCH better than using Binance because:
 * 1. No geo-restrictions
 * 2. Returns the exact openPrice Polymarket uses for resolution
 * 3. Works for all market types (15m, 1h, 4h, 1d)
 *
 * Example endpoint:
 * https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime=2025-12-23T17:00:00Z&variant=daily&endDate=2025-12-24T17:00:00Z
 *
 * Response format:
 * {
 *   "openPrice": 88027.69,
 *   "closePrice": null,
 *   "timestamp": 1766547977549,
 *   "completed": false,
 *   "incomplete": true,
 *   "cached": false
 * }
 */

interface PolymarketPriceResponse {
  openPrice: number | null;
  closePrice: number | null;
  timestamp: number;
  completed: boolean;
  incomplete: boolean;
  cached: boolean;
}

// Map interval to Polymarket variant parameter
type PriceVariant = '15m' | '30m' | 'hourly' | '4h' | 'daily';

function intervalToVariant(interval: string): PriceVariant {
  switch (interval) {
    case '15m':
      return '15m';
    case '30m':
      return '30m';
    case '1h':
      return 'hourly';
    case '4h':
      return '4h';
    case '1d':
      return 'daily';
    default:
      return 'hourly';
  }
}

// Map our asset names to Polymarket symbols
function assetToSymbol(asset: string): string {
  const map: Record<string, string> = {
    btc: 'BTC',
    eth: 'ETH',
    xrp: 'XRP',
    sol: 'SOL',
  };
  return map[asset.toLowerCase()] ?? asset.toUpperCase();
}

/**
 * Fetch the open price from Polymarket's crypto-price API
 *
 * @param asset - Asset name (btc, eth, xrp, sol)
 * @param interval - Market interval (15m, 30m, 1h, 4h, 1d)
 * @param eventStartTime - When the candle starts (ISO string or Date)
 * @param endDate - When the candle ends (ISO string or Date)
 */
export async function getPolymarketOpenPrice(
  asset: string,
  interval: string,
  eventStartTime: Date,
  endDate: Date
): Promise<number | null> {
  const symbol = assetToSymbol(asset);
  const variant = intervalToVariant(interval);

  // Format dates as ISO strings
  const startTimeStr = eventStartTime.toISOString();
  const endDateStr = endDate.toISOString();

  try {
    const url = `${POLYMARKET_API_BASE}/crypto-price`;
    debug(`Fetching ${symbol} ${variant}: start=${startTimeStr} end=${endDateStr}`);

    const response = await axios.get<PolymarketPriceResponse>(url, {
      params: {
        symbol,
        eventStartTime: startTimeStr,
        variant,
        endDate: endDateStr,
      },
      timeout: 10000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'PolyArb-Scanner/1.0',
      },
    });

    const data = response.data;

    if (data.openPrice !== null) {
      info(`Polymarket ${symbol} ${variant} open price: $${data.openPrice.toFixed(2)}`);
      return data.openPrice;
    }

    // Log more details about why openPrice is null
    info(`Polymarket ${symbol} ${variant}: openPrice=null, completed=${data.completed}, incomplete=${data.incomplete}`);
    return null;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { status?: number; data?: unknown } };
    if (axiosErr?.response?.status === 404) {
      debug(`Polymarket price not found for ${symbol} ${variant}`);
    } else {
      debug(`Failed to fetch Polymarket price for ${symbol} ${variant}: ${err}`);
    }
    return null;
  }
}

/**
 * Fetch the open price for a market based on its end time and interval
 * This calculates the start time from the end time and interval
 *
 * @param asset - Asset name (btc, eth, xrp, sol)
 * @param interval - Market interval (15m, 30m, 1h, 4h, 1d)
 * @param marketEndTime - When the market resolves
 */
export async function getMarketOpenPriceFromPolymarket(
  asset: string,
  interval: string,
  marketEndTime: Date
): Promise<number | null> {
  // Calculate start time based on interval
  const startTime = new Date(marketEndTime);

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
    default:
      warn(`Unknown interval: ${interval}, defaulting to 1h`);
      startTime.setTime(startTime.getTime() - 60 * 60 * 1000);
  }

  return getPolymarketOpenPrice(asset, interval, startTime, marketEndTime);
}

/**
 * Batch fetch open prices for multiple markets
 * Returns a map of "asset-interval-endTimestamp" -> openPrice
 */
export async function batchFetchOpenPrices(
  requests: Array<{
    asset: string;
    interval: string;
    endTime: Date;
  }>
): Promise<Map<string, number>> {
  const results = new Map<string, number>();

  info(`Fetching ${requests.length} open prices from Polymarket API...`);

  // Fetch in parallel with concurrency limit
  const BATCH_SIZE = 5;

  for (let i = 0; i < requests.length; i += BATCH_SIZE) {
    const batch = requests.slice(i, i + BATCH_SIZE);

    const promises = batch.map(async (req) => {
      const price = await getMarketOpenPriceFromPolymarket(req.asset, req.interval, req.endTime);
      const endTimestamp = Math.floor(req.endTime.getTime() / 1000);
      const key = `${req.asset}-${req.interval}-${endTimestamp}`;

      return { key, price };
    });

    const batchResults = await Promise.all(promises);

    for (const { key, price } of batchResults) {
      if (price !== null) {
        results.set(key, price);
      }
    }

    // Small delay between batches to be nice to the API
    if (i + BATCH_SIZE < requests.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  info(`Loaded ${results.size} open prices from Polymarket`);
  return results;
}
