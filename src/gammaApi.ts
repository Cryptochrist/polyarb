import axios from 'axios';
import { GAMMA_API_BASE } from './config.js';
import type { GammaMarket, MarketPair } from './types.js';
import { info, debug, error } from './logger.js';

// Raw API response has JSON strings for arrays
interface RawGammaMarket {
  id: string;
  question: string;
  slug: string;
  conditionId: string;
  clobTokenIds: string; // JSON string
  outcomes: string; // JSON string
  outcomePrices: string; // JSON string
  volume: string;
  volumeNum: number;
  liquidity: string;
  liquidityNum: number;
  enableOrderBook: boolean;
  active: boolean;
  closed: boolean;
  endDate: string;
  startDate?: string;
  category?: string;
  description?: string;
}

export interface MarketFilter {
  categories?: string[];         // e.g., ['Crypto', 'Sports']
  maxHoursUntilResolution?: number;  // Only markets resolving within N hours
  minLiquidity?: number;
  maxMarkets?: number;
  keywords?: string[];           // Search in question text
}

function parseMarket(raw: RawGammaMarket): GammaMarket & { category?: string; startDate?: string } {
  let clobTokenIds: string[] = [];
  let outcomes: string[] = [];
  let outcomePrices: string[] = [];

  try {
    clobTokenIds = JSON.parse(raw.clobTokenIds || '[]') as string[];
  } catch { /* ignore */ }

  try {
    outcomes = JSON.parse(raw.outcomes || '[]') as string[];
  } catch { /* ignore */ }

  try {
    outcomePrices = JSON.parse(raw.outcomePrices || '[]') as string[];
  } catch { /* ignore */ }

  return {
    ...raw,
    clobTokenIds,
    outcomes,
    outcomePrices,
  };
}

const client = axios.create({
  baseURL: GAMMA_API_BASE,
  timeout: 30000,
});

export async function fetchAllActiveMarkets(
  minLiquidity = 100,  // Only fetch markets with at least $100 liquidity
  maxMarkets = 2000    // Cap at 2000 markets for faster startup
): Promise<GammaMarket[]> {
  const allMarkets: GammaMarket[] = [];
  const limit = 100;
  let offset = 0;
  let hasMore = true;

  info(`Fetching active markets (minLiquidity: $${minLiquidity}, max: ${maxMarkets})...`);

  while (hasMore && allMarkets.length < maxMarkets) {
    try {
      const response = await client.get<RawGammaMarket[]>('/markets', {
        params: {
          limit,
          offset,
          active: true,
          closed: false,
          enableOrderBook: true,
          liquidity_num_min: minLiquidity,
          order: 'liquidityNum',
          ascending: false,  // Highest liquidity first
        },
      });

      const rawMarkets = response.data;

      if (rawMarkets.length === 0) {
        hasMore = false;
      } else {
        // Parse JSON strings and filter for binary markets
        const parsedMarkets = rawMarkets.map(parseMarket);
        const binaryMarkets = parsedMarkets.filter(
          (m) => m.outcomes.length === 2 && m.clobTokenIds.length === 2
        );
        allMarkets.push(...binaryMarkets);
        offset += limit;
        debug(`Fetched ${rawMarkets.length} markets, ${binaryMarkets.length} binary, total: ${allMarkets.length}`);
      }
    } catch (err) {
      error('Failed to fetch markets', err);
      hasMore = false;
    }
  }

  // Sort by liquidity descending
  allMarkets.sort((a, b) => b.liquidityNum - a.liquidityNum);

  info(`Found ${allMarkets.length} active binary markets with orderbooks`);
  return allMarkets.slice(0, maxMarkets);
}

export function createMarketPairs(markets: GammaMarket[]): MarketPair[] {
  return markets
    .filter((m) => m.clobTokenIds?.length === 2)
    .map((market) => ({
      market,
      yesTokenId: market.clobTokenIds[0]!,
      noTokenId: market.clobTokenIds[1]!,
    }));
}

export async function fetchMarketBySlug(slug: string): Promise<GammaMarket | null> {
  try {
    const response = await client.get<RawGammaMarket[]>('/markets', {
      params: { slug },
    });
    if (response.data && response.data.length > 0) {
      return parseMarket(response.data[0]!);
    }
    return null;
  } catch (err) {
    error(`Failed to fetch market by slug: ${slug}`, err);
    return null;
  }
}

/**
 * Fetch markets with advanced filtering for crypto/short-duration targeting
 * This is the key function for targeting fast-moving markets
 */
export async function fetchFilteredMarkets(filter: MarketFilter): Promise<GammaMarket[]> {
  const allMarkets: GammaMarket[] = [];
  const limit = 100;
  let offset = 0;
  let hasMore = true;
  const maxMarkets = filter.maxMarkets ?? 500;
  const minLiquidity = filter.minLiquidity ?? 100;

  const categoryStr = filter.categories?.join(', ') || 'all';
  info(`Fetching filtered markets (categories: ${categoryStr}, minLiquidity: $${minLiquidity})...`);

  while (hasMore && allMarkets.length < maxMarkets) {
    try {
      const params: Record<string, unknown> = {
        limit,
        offset,
        active: true,
        closed: false,
        enableOrderBook: true,
        liquidity_num_min: minLiquidity,
        order: 'liquidityNum',
        ascending: false,
      };

      // Add category filter if specified
      if (filter.categories?.length === 1) {
        params.category = filter.categories[0];
      }

      const response = await client.get<RawGammaMarket[]>('/markets', { params });
      const rawMarkets = response.data;

      if (rawMarkets.length === 0) {
        hasMore = false;
      } else {
        const parsedMarkets = rawMarkets.map(parseMarket);

        // Apply filters
        let filtered = parsedMarkets.filter(
          (m) => m.outcomes.length === 2 && m.clobTokenIds.length === 2
        );

        // Category filter (for multiple categories)
        if (filter.categories && filter.categories.length > 1) {
          filtered = filtered.filter((m) =>
            m.category && filter.categories!.includes(m.category)
          );
        }

        // Time filter: only markets resolving within N hours
        if (filter.maxHoursUntilResolution) {
          const now = Date.now();
          const maxMs = filter.maxHoursUntilResolution * 60 * 60 * 1000;
          filtered = filtered.filter((m) => {
            const endTime = new Date(m.endDate).getTime();
            return endTime > now && (endTime - now) <= maxMs;
          });
        }

        // Keyword filter
        if (filter.keywords?.length) {
          const lowerKeywords = filter.keywords.map((k) => k.toLowerCase());
          filtered = filtered.filter((m) =>
            lowerKeywords.some((kw) => m.question.toLowerCase().includes(kw))
          );
        }

        allMarkets.push(...filtered);
        offset += limit;
        debug(`Fetched ${rawMarkets.length}, filtered to ${filtered.length}, total: ${allMarkets.length}`);
      }
    } catch (err) {
      error('Failed to fetch filtered markets', err);
      hasMore = false;
    }
  }

  // Sort by end date ascending (soonest resolution first) for short-term focus
  if (filter.maxHoursUntilResolution) {
    allMarkets.sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());
  } else {
    allMarkets.sort((a, b) => b.liquidityNum - a.liquidityNum);
  }

  info(`Found ${allMarkets.length} filtered markets`);
  return allMarkets.slice(0, maxMarkets);
}

/**
 * Convenience function to fetch crypto markets only
 * Focuses on time-based price prediction markets (BTC/ETH 15m, 30m, 1h, 4h, etc.)
 */
export async function fetchCryptoMarkets(options: {
  minLiquidity?: number;
  maxMarkets?: number;
  maxHoursUntilResolution?: number;
  timeBasedOnly?: boolean;  // Only fetch 15m, 30m, 1h, 4h type markets
} = {}): Promise<GammaMarket[]> {
  // Keywords that identify crypto price prediction markets
  // Must contain both a crypto asset AND a time frame
  const cryptoPriceKeywords = [
    'BTC', 'Bitcoin', 'ETH', 'Ethereum', 'SOL', 'Solana',
    'XRP', 'DOGE', 'ADA', 'AVAX', 'MATIC', 'DOT', 'LINK',
  ];

  const timeFramePatterns = [
    /\b(1[05]|30)\s*m(in)?\b/i,           // 10m, 15m, 30m, 30min
    /\b[1-9]\s*h(our|r)?\b/i,              // 1h, 4h, 1hour, 4hr
    /\b(12|24)\s*h(our|r)?\b/i,            // 12h, 24h
    /\bprice\b.*\b(at|by)\b/i,             // "price at" or "price by"
    /\b(above|below|over|under)\s*\$?\d/i, // "above $100000" patterns
  ];

  const allMarkets = await fetchFilteredMarkets({
    categories: ['Crypto'],
    minLiquidity: options.minLiquidity ?? 500,
    maxMarkets: options.maxMarkets ?? 500, // Fetch more, then filter
    maxHoursUntilResolution: options.maxHoursUntilResolution,
  });

  // If timeBasedOnly is false, return all crypto markets
  if (options.timeBasedOnly === false) {
    return allMarkets.slice(0, options.maxMarkets ?? 200);
  }

  // Filter to only crypto price prediction markets with time frames
  const filtered = allMarkets.filter((market) => {
    const question = market.question;

    // Must contain a crypto asset name
    const hasCrypto = cryptoPriceKeywords.some((kw) =>
      question.toUpperCase().includes(kw.toUpperCase())
    );
    if (!hasCrypto) return false;

    // Must contain a time frame pattern
    const hasTimeFrame = timeFramePatterns.some((pattern) =>
      pattern.test(question)
    );
    return hasTimeFrame;
  });

  info(`Crypto time-based filter: ${allMarkets.length} -> ${filtered.length} markets`);
  return filtered.slice(0, options.maxMarkets ?? 200);
}

/**
 * Fetch short-duration markets (resolving within specified hours)
 * These markets have faster price movements = more arb opportunities
 */
export async function fetchShortDurationMarkets(
  maxHours: number = 24,
  minLiquidity: number = 500
): Promise<GammaMarket[]> {
  return fetchFilteredMarkets({
    maxHoursUntilResolution: maxHours,
    minLiquidity,
    maxMarkets: 300,
  });
}

/**
 * Time interval types for crypto up/down markets
 */
export type BTCMarketInterval = '15m' | '30m' | '1h' | '4h' | '1d';

/**
 * Supported crypto assets for up/down markets
 */
export type CryptoAsset = 'btc' | 'eth' | 'xrp' | 'sol';

export const ALL_CRYPTO_ASSETS: CryptoAsset[] = ['btc', 'eth', 'xrp', 'sol'];
export const ALL_INTERVALS: BTCMarketInterval[] = ['15m', '1h', '4h', '1d'];

/**
 * Series slugs for each asset and interval
 * 15m markets use slug pattern `{asset}-updown-15m-{timestamp}`
 * 1h/4h/1d markets are stored in series endpoint with different slugs
 */
interface SeriesConfig {
  seriesSlug: string;
  interval: BTCMarketInterval;
}

const SERIES_MAP: Record<CryptoAsset, Partial<Record<BTCMarketInterval, SeriesConfig>>> = {
  btc: {
    '1h': { seriesSlug: 'btc-up-or-down-hourly', interval: '1h' },
    '4h': { seriesSlug: 'btc-up-or-down-4h', interval: '4h' },
    '1d': { seriesSlug: 'btc-up-or-down-daily', interval: '1d' },
  },
  eth: {
    '1h': { seriesSlug: 'eth-up-or-down-hourly', interval: '1h' },
    '4h': { seriesSlug: 'eth-up-or-down-4h', interval: '4h' },
    '1d': { seriesSlug: 'eth-up-or-down-daily', interval: '1d' },
  },
  xrp: {
    '1h': { seriesSlug: 'xrp-up-or-down-hourly', interval: '1h' },
    '4h': { seriesSlug: 'xrp-up-or-down-4h', interval: '4h' },
  },
  sol: {
    '1h': { seriesSlug: 'solana-up-or-down-hourly', interval: '1h' },
    '4h': { seriesSlug: 'solana-up-or-down-4h', interval: '4h' },
  },
};

/**
 * Map interval to minutes
 */
const INTERVAL_MINUTES: Record<BTCMarketInterval, number> = {
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
  '1d': 1440,  // 24 hours
};

// Interface for series API response
interface SeriesEvent {
  id: string;
  title: string;
  slug: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  markets?: RawGammaMarket[];
}

interface SeriesResponse {
  id: string;
  slug: string;
  title: string;
  events?: SeriesEvent[];
}

/**
 * Fetch markets from the series endpoint
 * This is how we get 1h, 4h, and daily markets which use descriptive slugs
 */
async function fetchMarketsFromSeries(seriesSlug: string, interval: BTCMarketInterval): Promise<GammaMarket[]> {
  const markets: GammaMarket[] = [];
  const now = Date.now();

  // Calculate interval duration in milliseconds
  const intervalDurations: Record<BTCMarketInterval, number> = {
    '15m': 15 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
  };
  const intervalDuration = intervalDurations[interval];

  try {
    const response = await client.get<SeriesResponse[]>('/series', {
      params: { slug: seriesSlug },
    });

    if (response.data.length === 0) {
      debug(`Series not found: ${seriesSlug}`);
      return [];
    }

    const series = response.data[0]!;
    if (!series.events) {
      debug(`Series has no events: ${seriesSlug}`);
      return [];
    }

    // Filter to events that are currently active:
    // 1. Not closed
    // 2. End time is in the future (hasn't resolved yet)
    // 3. Start time (endDate - interval) is in the past or very near (within 2 minutes)
    const activeEvents = series.events.filter(e => {
      if (e.closed) return false;

      const endTime = new Date(e.endDate).getTime();
      const startTime = endTime - intervalDuration;

      // Must end in the future
      if (endTime <= now) return false;

      // Must have started (or start within 2 minutes for near-term markets)
      const twoMinutes = 2 * 60 * 1000;
      if (startTime > now + twoMinutes) return false;

      return true;
    });

    debug(`Series ${seriesSlug}: ${activeEvents.length} currently active events (filtered from ${series.events.length})`);

    // For each active event, we need to fetch the full event details to get market token IDs
    for (const event of activeEvents.slice(0, 10)) { // Limit to 10 nearest events
      try {
        const eventResp = await client.get<Array<{ markets: RawGammaMarket[] }>>('/events', {
          params: { slug: event.slug },
        });

        if (eventResp.data.length > 0 && eventResp.data[0]!.markets) {
          for (const rawMarket of eventResp.data[0]!.markets) {
            const market = parseMarket(rawMarket);
            if (market.clobTokenIds?.length === 2) {
              // Add interval metadata to the market for later use
              (market as GammaMarket & { interval?: string }).interval = interval;
              markets.push(market);
              debug(`Found ${interval} market: ${market.slug}`);
            }
          }
        }
      } catch (err) {
        debug(`Failed to fetch event ${event.slug}`);
      }
    }
  } catch (err) {
    error(`Failed to fetch series ${seriesSlug}`, err);
  }

  return markets;
}

/**
 * Fetch up/down markets for a specific crypto asset
 *
 * 15m markets use slug pattern: {asset}-updown-15m-{unix_timestamp}
 * 1h/4h/1d markets use series endpoint with descriptive slugs
 */
export async function fetchAssetUpDownMarkets(
  asset: CryptoAsset,
  intervals: BTCMarketInterval[] = ['15m', '1h', '4h', '1d'],
  lookAheadSlots: number = 5
): Promise<GammaMarket[]> {
  const markets: GammaMarket[] = [];
  const seenSlugs = new Set<string>();

  debug(`Searching for ${asset.toUpperCase()} up/down markets (intervals: ${intervals.join(', ')})...`);

  for (const interval of intervals) {
    // Check if this asset/interval combo has a series
    const seriesConfig = SERIES_MAP[asset]?.[interval];

    if (seriesConfig) {
      // Fetch from series endpoint (1h, 4h, 1d markets)
      const seriesMarkets = await fetchMarketsFromSeries(seriesConfig.seriesSlug, interval);
      for (const m of seriesMarkets) {
        if (!seenSlugs.has(m.slug)) {
          seenSlugs.add(m.slug);
          markets.push(m);
        }
      }
    } else {
      // Use slug pattern for 15m (and 30m) markets
      const minutes = INTERVAL_MINUTES[interval];

      // Create fresh date for each interval to avoid mutation issues
      const now = new Date();

      // Calculate current interval start
      const currentMinute = now.getUTCMinutes();
      const currentHour = now.getUTCHours();

      if (interval === '1d') {
        // Daily markets start at midnight UTC
        now.setUTCHours(0, 0, 0, 0);
      } else if (minutes >= 60) {
        // For hourly intervals, round to hour boundary
        const hoursInInterval = minutes / 60;
        const roundedHour = Math.floor(currentHour / hoursInInterval) * hoursInInterval;
        now.setUTCHours(roundedHour, 0, 0, 0);
      } else {
        // For sub-hourly, round to interval boundary
        const roundedMinutes = Math.floor(currentMinute / minutes) * minutes;
        now.setUTCMinutes(roundedMinutes, 0, 0);
      }

      const baseTimestamp = Math.floor(now.getTime() / 1000);
      const intervalSeconds = minutes * 60;

      // Check current and future intervals
      for (let i = 0; i < lookAheadSlots; i++) {
        const timestamp = baseTimestamp + (i * intervalSeconds);
        const slug = `${asset}-updown-${interval}-${timestamp}`;

        if (seenSlugs.has(slug)) continue;

        try {
          const market = await fetchMarketBySlug(slug);
          if (market && market.clobTokenIds?.length === 2) {
            seenSlugs.add(slug);
            // Add interval metadata
            (market as GammaMarket & { interval?: string }).interval = interval;
            markets.push(market);
            debug(`Found ${asset.toUpperCase()} ${interval} market: ${slug}`);
          }
        } catch (err) {
          debug(`Market not found: ${slug}`);
        }
      }
    }
  }

  return markets;
}

/**
 * Fetch BTC up/down markets by constructing time-based slugs
 * Uses the pattern from polydatalogger: btc-updown-{interval}-{unix_timestamp}
 *
 * These markets have new instances every interval (15m, 30m, 1h, 4h, 1d)
 * and are excellent for arbitrage due to rapid price movements.
 */
export async function fetchBTCUpDownMarkets(
  intervals: BTCMarketInterval[] = ['15m', '1h', '4h', '1d'],
  lookAheadSlots: number = 5  // How many future intervals to check
): Promise<GammaMarket[]> {
  const markets = await fetchAssetUpDownMarkets('btc', intervals, lookAheadSlots);

  // Also search via API for any btc-updown markets we might have missed
  try {
    const response = await client.get<RawGammaMarket[]>('/markets', {
      params: {
        limit: 100,
        active: true,
        closed: false,
        enableOrderBook: true,
      },
    });

    for (const raw of response.data) {
      const slug = raw.slug || '';
      // Match btc-updown-15m-*, btc-updown-30m-*, btc-updown-1h-*, btc-updown-4h-*, btc-updown-1d-*
      if (/^btc-updown-(15m|30m|1h|4h|1d)-\d+$/.test(slug)) {
        const market = parseMarket(raw);
        if (market.clobTokenIds?.length === 2) {
          // Avoid duplicates
          if (!markets.find(m => m.slug === market.slug)) {
            markets.push(market);
            debug(`Found BTC market via search: ${slug}`);
          }
        }
      }
    }
  } catch (err) {
    error('Failed to search for BTC markets', err);
  }

  // Sort by end date (soonest first)
  markets.sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());

  info(`Found ${markets.length} active BTC up/down markets`);
  return markets;
}

/**
 * Fetch ETH up/down markets using similar pattern
 */
export async function fetchETHUpDownMarkets(
  intervals: BTCMarketInterval[] = ['15m', '1h'],
  lookAheadSlots: number = 5
): Promise<GammaMarket[]> {
  const markets: GammaMarket[] = [];

  info(`Searching for ETH up/down markets (intervals: ${intervals.join(', ')})...`);

  // Search via API for eth-updown markets
  try {
    const response = await client.get<RawGammaMarket[]>('/markets', {
      params: {
        limit: 100,
        active: true,
        closed: false,
        enableOrderBook: true,
      },
    });

    for (const raw of response.data) {
      const slug = raw.slug || '';
      // Match eth-updown-15m-*, eth-updown-1h-*, etc.
      if (/^eth-updown-(15m|30m|1h|4h)-\d+$/.test(slug)) {
        const market = parseMarket(raw);
        if (market.clobTokenIds?.length === 2) {
          markets.push(market);
          debug(`Found ETH market: ${slug}`);
        }
      }
    }
  } catch (err) {
    error('Failed to search for ETH markets', err);
  }

  markets.sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());
  info(`Found ${markets.length} active ETH up/down markets`);
  return markets;
}

/**
 * Fetch all crypto up/down markets for all supported assets (BTC, ETH, XRP, SOL)
 * This is the main function to use for cross-market arbitrage scanning
 *
 * For each asset, we track 4 markets per interval:
 * - 15m: 4 markets (current + next 3)
 * - 1h: 4 markets
 * - 4h: 4 markets
 * - 1d: 4 markets
 *
 * Total: 4 assets × 4 intervals × 4 slots = 64 markets max
 */
export async function fetchAllCryptoUpDownMarkets(
  intervals: BTCMarketInterval[] = ['15m', '1h', '4h', '1d'],
  assets: CryptoAsset[] = ALL_CRYPTO_ASSETS
): Promise<GammaMarket[]> {
  const allMarkets: GammaMarket[] = [];
  const seenSlugs = new Set<string>();

  info(`Fetching up/down markets for ${assets.length} assets (${assets.join(', ')})...`);

  // Fetch markets for each asset
  for (const asset of assets) {
    const markets = await fetchAssetUpDownMarkets(asset, intervals, 4);
    for (const m of markets) {
      if (!seenSlugs.has(m.slug)) {
        seenSlugs.add(m.slug);
        allMarkets.push(m);
      }
    }
  }

  // Also do a broad search for any *-updown-* patterns we might have missed
  try {
    const response = await client.get<RawGammaMarket[]>('/markets', {
      params: {
        limit: 300,
        active: true,
        closed: false,
        enableOrderBook: true,
      },
    });

    // Build pattern to match supported assets
    const assetPattern = assets.join('|');
    const intervalPattern = intervals.join('|').replace(/1d/g, '1d');
    const regex = new RegExp(`^(${assetPattern})-updown-(${intervalPattern})-\\d+$`, 'i');

    for (const raw of response.data) {
      const slug = raw.slug || '';
      if (regex.test(slug)) {
        const market = parseMarket(raw);
        if (market.clobTokenIds?.length === 2 && !seenSlugs.has(market.slug)) {
          seenSlugs.add(market.slug);
          allMarkets.push(market);
          debug(`Found crypto updown market: ${slug}`);
        }
      }
    }
  } catch (err) {
    error('Failed to search for crypto updown markets', err);
  }

  // Sort by end date (soonest first)
  allMarkets.sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());

  // Log breakdown by asset
  const byAsset = new Map<string, number>();
  for (const m of allMarkets) {
    const asset = m.slug.split('-')[0]!;
    byAsset.set(asset, (byAsset.get(asset) || 0) + 1);
  }

  const breakdown = [...byAsset.entries()].map(([a, c]) => `${a.toUpperCase()}: ${c}`).join(', ');
  info(`Total crypto up/down markets found: ${allMarkets.length} (${breakdown})`);

  return allMarkets;
}
