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
    const response = await client.get<GammaMarket[]>('/markets', {
      params: { slug },
    });
    return response.data[0] ?? null;
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
 */
export async function fetchCryptoMarkets(options: {
  minLiquidity?: number;
  maxMarkets?: number;
  maxHoursUntilResolution?: number;
} = {}): Promise<GammaMarket[]> {
  return fetchFilteredMarkets({
    categories: ['Crypto'],
    minLiquidity: options.minLiquidity ?? 500,
    maxMarkets: options.maxMarkets ?? 200,
    maxHoursUntilResolution: options.maxHoursUntilResolution,
  });
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
