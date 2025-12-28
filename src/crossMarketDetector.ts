import type { GammaMarket, MarketPair, OrderBook } from './types.js';
import type { ParsedBookUpdate } from './websocket.js';
import { getBestAsk, getBestBid } from './clobApi.js';
import { info, debug, warn, error } from './logger.js';
import type { BTCMarketInterval } from './gammaApi.js';
import { getMarketOpenPriceFromPolymarket } from './polymarketPriceApi.js';

/**
 * Cross-market arbitrage opportunity
 *
 * When a 1h market has ≤15 minutes remaining, it resolves at the same time as a 15m market.
 * They have different starting reference prices, creating a "profit zone" where both bets win.
 *
 * Example:
 * - 1h market started at $100,000 BTC (45 mins ago)
 * - 15m market started at $99,000 BTC (just now)
 * - If BTC ends at $99,500 (between the two refs):
 *   - 1h: $99,500 < $100,000 → DOWN wins
 *   - 15m: $99,500 > $99,000 → UP wins
 *   - Buying 1h-DOWN + 15m-UP both pay $1.00!
 */
export interface CrossMarketOpportunity {
  // The two markets
  longMarket: GammaMarket;   // 1h market (started earlier)
  shortMarket: GammaMarket;  // 15m market (started later)

  // Market intervals
  longInterval: BTCMarketInterval;
  shortInterval: BTCMarketInterval;

  // Token IDs for trading
  longUpTokenId: string;
  longDownTokenId: string;
  shortUpTokenId: string;
  shortDownTokenId: string;

  // Reference prices extracted from market questions
  longRefPrice: number;     // Reference price for 1h market
  shortRefPrice: number;    // Reference price for 15m market

  // The profit zone (if any)
  profitZoneLow: number;    // Lower bound of profit zone
  profitZoneHigh: number;   // Upper bound of profit zone

  // Direction: which positions to buy for the profit zone
  // If longRef > shortRef: buy longDown + shortUp (profit if price lands between)
  // If shortRef > longRef: buy shortDown + longUp (profit if price lands between)
  strategy: 'LONG_DOWN_SHORT_UP' | 'LONG_UP_SHORT_DOWN';

  // Current market prices (asks)
  longUpAsk: number;
  longDownAsk: number;
  shortUpAsk: number;
  shortDownAsk: number;

  // The cost to enter the arbitrage position
  entryCost: number;        // Cost of both positions

  // Theoretical profit if BTC lands in profit zone
  maxProfit: number;        // $2.00 - entryCost

  // Risk metrics
  profitZoneWidth: number;  // How wide the profit zone is in USD
  profitZonePercent: number; // Width as % of average ref price

  // Max shares we can trade
  maxShares: number;

  // Time until resolution
  resolutionTime: Date;
  minutesUntilResolution: number;

  timestamp: Date;
}

interface TokenPrice {
  bestAsk: number | null;
  bestAskSize: number | null;
  bestBid: number | null;
  bestBidSize: number | null;
  lastUpdate: Date;
}

interface MarketInfo {
  market: GammaMarket;
  pair: MarketPair;
  interval: BTCMarketInterval;
  asset: string;  // 'btc', 'eth', etc.
  resolutionTimestamp: number;
  candleStartTimestamp: number;  // When the candle started
  referencePrice: number | null;  // Open price from Polymarket API
}

/**
 * Calculate the candle start time from the end time and interval
 */
function calculateCandleStartTime(endTime: Date, interval: BTCMarketInterval): Date {
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
 * Detects cross-market arbitrage opportunities between different timeframe markets
 * that resolve at the same time but have different reference prices.
 *
 * The reference prices are fetched from Polymarket's crypto-price API - they represent
 * the exact candle open price that Polymarket uses for resolution.
 */
export class CrossMarketDetector {
  private tokenPrices: Map<string, TokenPrice> = new Map();
  private marketInfos: Map<string, MarketInfo> = new Map(); // slug -> MarketInfo
  private minProfit: number;
  private pricesLoaded = false;
  private _loggedPairs: Set<string> = new Set();

  // Persistent cache of reference prices by slug - survives market refresh
  private refPriceCache: Map<string, number> = new Map();

  constructor(minProfit: number = 0.001) {
    this.minProfit = minProfit;
  }

  /**
   * Register markets for cross-market analysis
   * Preserves existing reference prices using persistent cache
   */
  setMarketPairs(pairs: MarketPair[]): void {
    // Save current reference prices to persistent cache before clearing
    for (const [slug, mktInfo] of this.marketInfos) {
      if (mktInfo.referencePrice !== null) {
        this.refPriceCache.set(slug, mktInfo.referencePrice);
      }
    }

    this.marketInfos.clear();
    // Don't reset pricesLoaded - we want to preserve the fact that we've tried loading

    let restored = 0;
    for (const pair of pairs) {
      const marketInfo = this.parseMarketInfo(pair);
      if (marketInfo) {
        // Restore from persistent cache if available
        const cachedPrice = this.refPriceCache.get(pair.market.slug);
        if (cachedPrice !== undefined) {
          marketInfo.referencePrice = cachedPrice;
          restored++;
        }
        this.marketInfos.set(pair.market.slug, marketInfo);
        debug(`Registered market: ${pair.market.slug} | interval: ${marketInfo.interval} | resolves: ${new Date(marketInfo.resolutionTimestamp * 1000).toISOString()}`);
      }
    }

    if (restored > 0) {
      info(`CrossMarketDetector tracking ${this.marketInfos.size} markets (${restored} reference prices restored from cache)`);
    } else {
      info(`CrossMarketDetector tracking ${this.marketInfos.size} markets`);
    }
  }

  /**
   * Load reference prices from Polymarket's crypto-price API for all tracked markets
   * This fetches the exact candle open price that Polymarket uses for resolution
   *
   * @param force - If true, reload all missing prices even if we've loaded before
   */
  async loadReferencePrices(force = false): Promise<void> {
    // First, restore any missing prices from persistent cache
    let restored = 0;
    for (const [slug, marketInfo] of this.marketInfos) {
      if (marketInfo.referencePrice === null) {
        const cachedPrice = this.refPriceCache.get(slug);
        if (cachedPrice !== undefined) {
          marketInfo.referencePrice = cachedPrice;
          restored++;
        }
      }
    }

    // Count how many are still missing after cache restore
    let missing = 0;
    const missingMarkets: MarketInfo[] = [];
    for (const marketInfo of this.marketInfos.values()) {
      if (marketInfo.referencePrice === null) {
        missing++;
        missingMarkets.push(marketInfo);
      }
    }

    // Skip if we've loaded and nothing is missing (unless forced)
    if (this.pricesLoaded && missing === 0 && !force) return;

    if (missing > 0) {
      // Show which specific markets are missing prices
      const missingList = missingMarkets.slice(0, 5).map(m => `${m.asset.toUpperCase()}-${m.interval}`).join(', ');
      info(`Loading ${missing} missing reference prices: ${missingList}${missing > 5 ? '...' : ''}`);
    }

    let loaded = 0;
    let failed = 0;

    for (const [slug, marketInfo] of this.marketInfos) {
      if (marketInfo.referencePrice !== null) continue;

      try {
        const endTime = new Date(marketInfo.resolutionTimestamp * 1000);
        const openPrice = await getMarketOpenPriceFromPolymarket(
          marketInfo.asset,
          marketInfo.interval,
          endTime
        );

        if (openPrice !== null) {
          marketInfo.referencePrice = openPrice;
          // Also save to persistent cache so it survives market refresh
          this.refPriceCache.set(slug, openPrice);
          loaded++;
          info(`${slug}: Loaded reference price $${openPrice.toFixed(2)}`);
        } else {
          failed++;
          // Log why we couldn't get the price (API returned null)
          debug(`${slug}: Polymarket API returned null for ${marketInfo.asset} ${marketInfo.interval}`);
        }
      } catch (err) {
        failed++;
        debug(`Failed to load Polymarket price for ${slug}: ${err}`);
      }
    }

    this.pricesLoaded = true;
    if (loaded > 0 || failed > 0) {
      info(`Reference prices: loaded ${loaded}, failed ${failed} (still missing: ${missing - loaded})`);
    }
  }

  /**
   * Parse market info from slug pattern
   *
   * Supports two formats:
   * 1. 15m markets: {asset}-updown-{interval}-{timestamp}
   *    Example: btc-updown-15m-1734998400
   *
   * 2. 1h/4h/1d markets: {asset}-up-or-down-{date}-{time}-et
   *    Example: bitcoin-up-or-down-december-23-10pm-et
   *
   * Also checks for interval metadata from gammaApi
   */
  private parseMarketInfo(pair: MarketPair): MarketInfo | null {
    const slug = pair.market.slug;
    const market = pair.market as GammaMarket & { interval?: BTCMarketInterval };

    // First check if the market has interval metadata (set by fetchMarketsFromSeries)
    if (market.interval) {
      return this.parseSeriesMarket(pair, market.interval);
    }

    // Try 15m slug pattern: {asset}-updown-{interval}-{timestamp}
    const match15m = slug.match(/^([a-z]+)-updown-(15m|30m|1h|4h|1d)-(\d+)$/i);
    if (match15m) {
      const asset = match15m[1]!.toLowerCase();
      const interval = match15m[2] as BTCMarketInterval;
      const timestamp = parseInt(match15m[3]!, 10);

      // The timestamp in the slug IS the candle start time
      const candleStartTimestamp = timestamp;

      // Use endDate from the market for resolution time (consistent with 1h markets)
      // This ensures 15m and 1h markets that resolve together have matching timestamps
      const resolutionTimestamp = Math.floor(new Date(pair.market.endDate).getTime() / 1000);

      return {
        market: pair.market,
        pair,
        interval,
        asset,
        resolutionTimestamp,
        candleStartTimestamp,
        referencePrice: null,  // Will be loaded from Polymarket API
      };
    }

    // Try 1h/4h/1d descriptive slug: {asset}-up-or-down-{date}
    // Examples:
    //   bitcoin-up-or-down-december-23-10pm-et (hourly)
    //   btc-up-or-down-4h-december-23-8pm-et (4h)
    //   btc-up-or-down-daily-december-23-et (daily)
    const matchDescriptive = slug.match(/^(bitcoin|ethereum|solana|xrp|btc|eth|sol)-up-or-down-(.+)$/i);
    if (matchDescriptive) {
      return this.parseDescriptiveSlug(pair, slug);
    }

    return null;
  }

  /**
   * Parse a market that came from the series endpoint (1h, 4h, 1d)
   */
  private parseSeriesMarket(pair: MarketPair, interval: BTCMarketInterval): MarketInfo | null {
    const slug = pair.market.slug;

    // Determine asset from slug
    let asset: string;
    if (slug.toLowerCase().includes('bitcoin') || slug.toLowerCase().startsWith('btc')) {
      asset = 'btc';
    } else if (slug.toLowerCase().includes('ethereum') || slug.toLowerCase().startsWith('eth')) {
      asset = 'eth';
    } else if (slug.toLowerCase().includes('solana') || slug.toLowerCase().startsWith('sol')) {
      asset = 'sol';
    } else if (slug.toLowerCase().includes('xrp')) {
      asset = 'xrp';
    } else {
      debug(`Unknown asset in slug: ${slug}`);
      return null;
    }

    // Get resolution timestamp from endDate
    const resolutionTimestamp = Math.floor(new Date(pair.market.endDate).getTime() / 1000);

    // Calculate candle start time by subtracting interval duration
    const endTime = new Date(pair.market.endDate);
    const candleStartTime = calculateCandleStartTime(endTime, interval);
    const candleStartTimestamp = Math.floor(candleStartTime.getTime() / 1000);

    return {
      market: pair.market,
      pair,
      interval,
      asset,
      resolutionTimestamp,
      candleStartTimestamp,
      referencePrice: null,  // Will be loaded from Polymarket API
    };
  }

  /**
   * Parse descriptive slug format for 1h/4h/1d markets
   */
  private parseDescriptiveSlug(pair: MarketPair, slug: string): MarketInfo | null {
    // Determine asset
    let asset: string;
    if (slug.toLowerCase().includes('bitcoin') || slug.toLowerCase().startsWith('btc')) {
      asset = 'btc';
    } else if (slug.toLowerCase().includes('ethereum') || slug.toLowerCase().startsWith('eth')) {
      asset = 'eth';
    } else if (slug.toLowerCase().includes('solana') || slug.toLowerCase().startsWith('sol')) {
      asset = 'sol';
    } else if (slug.toLowerCase().includes('xrp')) {
      asset = 'xrp';
    } else {
      return null;
    }

    // Determine interval from slug pattern
    let interval: BTCMarketInterval;
    if (slug.includes('-4h-')) {
      interval = '4h';
    } else if (slug.includes('-daily-')) {
      interval = '1d';
    } else {
      // Default to 1h for patterns like "bitcoin-up-or-down-december-23-10pm-et"
      interval = '1h';
    }

    // Get resolution timestamp from endDate
    const resolutionTimestamp = Math.floor(new Date(pair.market.endDate).getTime() / 1000);

    // Calculate candle start time
    const endTime = new Date(pair.market.endDate);
    const candleStartTime = calculateCandleStartTime(endTime, interval);
    const candleStartTimestamp = Math.floor(candleStartTime.getTime() / 1000);

    return {
      market: pair.market,
      pair,
      interval,
      asset,
      resolutionTimestamp,
      candleStartTimestamp,
      referencePrice: null,  // Will be loaded from Polymarket API
    };
  }

  /**
   * Extract the reference price from the market question
   * Example: "Will BTC be up from $99,547.10 on Dec 23 at 8:00 PM?"
   */
  private extractReferencePrice(question: string): number | null {
    // Match patterns like "$99,547.10" or "$100,000" or "$100000.50"
    const match = question.match(/\$([0-9,]+(?:\.[0-9]+)?)/);
    if (!match) return null;

    // Remove commas and parse
    const priceStr = match[1]!.replace(/,/g, '');
    const price = parseFloat(priceStr);

    return isNaN(price) ? null : price;
  }

  private getIntervalSeconds(interval: BTCMarketInterval): number {
    const map: Record<BTCMarketInterval, number> = {
      '15m': 15 * 60,
      '30m': 30 * 60,
      '1h': 60 * 60,
      '4h': 4 * 60 * 60,
      '1d': 24 * 60 * 60,
    };
    return map[interval];
  }

  /**
   * Update price data from orderbook
   */
  updateFromOrderBook(tokenId: string, book: OrderBook): CrossMarketOpportunity | null {
    const bestAsk = getBestAsk(book);
    const bestBid = getBestBid(book);

    this.tokenPrices.set(tokenId, {
      bestAsk: bestAsk?.price ?? null,
      bestAskSize: bestAsk?.size ?? null,
      bestBid: bestBid?.price ?? null,
      bestBidSize: bestBid?.size ?? null,
      lastUpdate: new Date(),
    });

    return this.checkCrossMarketOpportunities(tokenId);
  }

  /**
   * Update price data from WebSocket
   */
  updateFromWebSocket(update: ParsedBookUpdate): CrossMarketOpportunity | null {
    const existing = this.tokenPrices.get(update.tokenId);

    this.tokenPrices.set(update.tokenId, {
      bestAsk: update.bestAsk ?? existing?.bestAsk ?? null,
      bestAskSize: update.bestAskSize ?? existing?.bestAskSize ?? null,
      bestBid: update.bestBid ?? existing?.bestBid ?? null,
      bestBidSize: update.bestBidSize ?? existing?.bestBidSize ?? null,
      lastUpdate: update.timestamp,
    });

    return this.checkCrossMarketOpportunities(update.tokenId);
  }

  /**
   * Check for cross-market opportunities when a price updates
   */
  private checkCrossMarketOpportunities(tokenId: string): CrossMarketOpportunity | null {
    // Find which market this token belongs to
    let updatedInfo: MarketInfo | null = null;

    for (const info of this.marketInfos.values()) {
      if (info.pair.yesTokenId === tokenId || info.pair.noTokenId === tokenId) {
        updatedInfo = info;
        break;
      }
    }

    if (!updatedInfo) return null;

    // Find markets with matching resolution time but different intervals
    const opportunities: CrossMarketOpportunity[] = [];

    for (const otherInfo of this.marketInfos.values()) {
      // Skip if same market or different asset
      if (otherInfo.market.slug === updatedInfo.market.slug) continue;
      if (otherInfo.asset !== updatedInfo.asset) continue;

      // Skip if same interval
      if (otherInfo.interval === updatedInfo.interval) continue;

      // Check if they resolve at the same time (within 5 minutes tolerance)
      // Markets may have slightly different endDate timestamps from the API
      const timeDiff = Math.abs(otherInfo.resolutionTimestamp - updatedInfo.resolutionTimestamp);
      if (timeDiff > 300) continue;

      // Found a pair! Check for arbitrage
      debug(`Found overlapping pair: ${updatedInfo.asset.toUpperCase()} ${updatedInfo.interval} + ${otherInfo.interval} (diff: ${timeDiff}s)`);
      const opp = this.checkPairForArbitrage(updatedInfo, otherInfo);
      if (opp) {
        opportunities.push(opp);
      }
    }

    // Return the best opportunity if any
    if (opportunities.length === 0) return null;

    return opportunities.sort((a, b) => b.maxProfit - a.maxProfit)[0]!;
  }

  /**
   * Check a specific pair of markets for cross-market arbitrage
   */
  private checkPairForArbitrage(info1: MarketInfo, info2: MarketInfo): CrossMarketOpportunity | null {
    // Determine which is the "long" (started earlier) vs "short" (started later) market
    // For interval comparison: 1d > 4h > 1h > 30m > 15m
    const intervalOrder: Record<BTCMarketInterval, number> = {
      '1d': 5,
      '4h': 4,
      '1h': 3,
      '30m': 2,
      '15m': 1,
    };

    let longInfo: MarketInfo;
    let shortInfo: MarketInfo;

    if (intervalOrder[info1.interval] > intervalOrder[info2.interval]) {
      longInfo = info1;
      shortInfo = info2;
    } else {
      longInfo = info2;
      shortInfo = info1;
    }

    // Need reference prices for both - silently skip if missing
    if (!longInfo.referencePrice || !shortInfo.referencePrice) {
      return null;
    }

    // Get current prices for all 4 tokens
    const longUpPrice = this.tokenPrices.get(longInfo.pair.yesTokenId);
    const longDownPrice = this.tokenPrices.get(longInfo.pair.noTokenId);
    const shortUpPrice = this.tokenPrices.get(shortInfo.pair.yesTokenId);
    const shortDownPrice = this.tokenPrices.get(shortInfo.pair.noTokenId);

    // Get ask prices, using 0 if not available (will affect cost calculation)
    // For thinly traded markets, some tokens may not have asks
    // Use || instead of ?? to also handle NaN values
    const longUpAsk = (longUpPrice?.bestAsk && !isNaN(longUpPrice.bestAsk)) ? longUpPrice.bestAsk : 0;
    const longDownAsk = (longDownPrice?.bestAsk && !isNaN(longDownPrice.bestAsk)) ? longDownPrice.bestAsk : 0;
    const shortUpAsk = (shortUpPrice?.bestAsk && !isNaN(shortUpPrice.bestAsk)) ? shortUpPrice.bestAsk : 0;
    const shortDownAsk = (shortDownPrice?.bestAsk && !isNaN(shortDownPrice.bestAsk)) ? shortDownPrice.bestAsk : 0;

    // Log once per pair if any prices are missing (only at debug level)
    const pairKey = `${longInfo.market.slug}|${shortInfo.market.slug}`;
    if (!this._loggedPairs.has(pairKey)) {
      const missing: string[] = [];
      if (!longUpPrice?.bestAsk) missing.push(`longUp(${longInfo.pair.yesTokenId.slice(0,8)})`);
      if (!longDownPrice?.bestAsk) missing.push(`longDown(${longInfo.pair.noTokenId.slice(0,8)})`);
      if (!shortUpPrice?.bestAsk) missing.push(`shortUp(${shortInfo.pair.yesTokenId.slice(0,8)})`);
      if (!shortDownPrice?.bestAsk) missing.push(`shortDown(${shortInfo.pair.noTokenId.slice(0,8)})`);

      if (missing.length > 0) {
        this._loggedPairs.add(pairKey);
        // Also log what prices we DO have
        const have: string[] = [];
        if (longUpPrice?.bestAsk) have.push(`longUp=$${longUpPrice.bestAsk.toFixed(3)}`);
        if (longDownPrice?.bestAsk) have.push(`longDown=$${longDownPrice.bestAsk.toFixed(3)}`);
        if (shortUpPrice?.bestAsk) have.push(`shortUp=$${shortUpPrice.bestAsk.toFixed(3)}`);
        if (shortDownPrice?.bestAsk) have.push(`shortDown=$${shortDownPrice.bestAsk.toFixed(3)}`);
        info(`${longInfo.asset.toUpperCase()} ${longInfo.interval}/${shortInfo.interval}: Missing [${missing.join(', ')}], Have [${have.join(', ')}]`);
      }
    }

    const longRef = longInfo.referencePrice;
    const shortRef = shortInfo.referencePrice;

    debug(`Pair: ${longInfo.market.slug} (${longInfo.interval}) vs ${shortInfo.market.slug} (${shortInfo.interval})`);
    debug(`  Ref prices: $${longRef.toFixed(2)} vs $${shortRef.toFixed(2)} (diff: $${Math.abs(longRef - shortRef).toFixed(2)})`);

    // If reference prices are identical, there's no profit zone - you can't win both bets
    // When refs are equal, price will either be >= both (both UP win) or < both (both DOWN win)
    // But we still report it so the user can see the pair exists
    const identicalRefs = longRef === shortRef;
    if (identicalRefs) {
      debug(`  Note: identical reference prices ($${longRef.toFixed(2)}), no profit zone but reporting pair`);
    }

    // Determine profit zone and strategy
    let strategy: 'LONG_DOWN_SHORT_UP' | 'LONG_UP_SHORT_DOWN';
    let profitZoneLow: number;
    let profitZoneHigh: number;
    let entryCost: number;
    let maxShares: number;

    // Track if we have valid prices for the required positions
    let hasBothPrices = false;

    if (identicalRefs) {
      // When refs are identical, show the best available trade (DOWN+UP typically)
      // No profit zone exists, but we still report for visibility
      strategy = 'LONG_DOWN_SHORT_UP';
      profitZoneLow = longRef;
      profitZoneHigh = longRef;  // Zero width
      entryCost = longDownAsk + shortUpAsk;
      hasBothPrices = longDownAsk > 0 && shortUpAsk > 0;

      const longDownSize = longDownPrice?.bestAskSize ?? 0;
      const shortUpSize = shortUpPrice?.bestAskSize ?? 0;
      maxShares = Math.min(
        longDownSize > 0 ? longDownSize : 1000,
        shortUpSize > 0 ? shortUpSize : 1000
      );
    } else if (longRef > shortRef) {
      // If BTC ends between shortRef and longRef:
      // - Long: price < longRef → DOWN wins
      // - Short: price >= shortRef → UP wins
      // Strategy: Buy longDown + shortUp
      strategy = 'LONG_DOWN_SHORT_UP';
      profitZoneLow = shortRef;
      profitZoneHigh = longRef;
      entryCost = longDownAsk + shortUpAsk;
      hasBothPrices = longDownAsk > 0 && shortUpAsk > 0;

      const longDownSize = longDownPrice?.bestAskSize ?? 0;
      const shortUpSize = shortUpPrice?.bestAskSize ?? 0;
      maxShares = Math.min(
        longDownSize > 0 ? longDownSize : 1000,
        shortUpSize > 0 ? shortUpSize : 1000
      );
    } else {
      // If BTC ends between longRef and shortRef:
      // - Long: price >= longRef → UP wins
      // - Short: price < shortRef → DOWN wins
      // Strategy: Buy longUp + shortDown
      strategy = 'LONG_UP_SHORT_DOWN';
      profitZoneLow = longRef;
      profitZoneHigh = shortRef;
      entryCost = longUpAsk + shortDownAsk;
      hasBothPrices = longUpAsk > 0 && shortDownAsk > 0;

      const longUpSize = longUpPrice?.bestAskSize ?? 0;
      const shortDownSize = shortDownPrice?.bestAskSize ?? 0;
      maxShares = Math.min(
        longUpSize > 0 ? longUpSize : 1000,
        shortDownSize > 0 ? shortDownSize : 1000
      );
    }

    // If we don't have valid prices for both required positions, skip this pair
    if (!hasBothPrices) {
      // Log which specific tokens are missing
      const missingTokens: string[] = [];
      if (strategy === 'LONG_DOWN_SHORT_UP') {
        if (longDownAsk === 0) missingTokens.push(`${longInfo.interval}-DOWN(${longInfo.pair.noTokenId.slice(0, 8)})`);
        if (shortUpAsk === 0) missingTokens.push(`${shortInfo.interval}-UP(${shortInfo.pair.yesTokenId.slice(0, 8)})`);
      } else {
        if (longUpAsk === 0) missingTokens.push(`${longInfo.interval}-UP(${longInfo.pair.yesTokenId.slice(0, 8)})`);
        if (shortDownAsk === 0) missingTokens.push(`${shortInfo.interval}-DOWN(${shortInfo.pair.noTokenId.slice(0, 8)})`);
      }
      debug(`Pair rejected - missing asks for: ${missingTokens.join(', ')}`);
      return null;
    }

    // Calculate profit: If price lands in zone, both positions pay $1 each = $2 total
    // For identical refs, this will be negative (no profit zone exists)
    const maxProfit = identicalRefs ? -entryCost : (2.0 - entryCost);

    debug(`  Entry cost: $${entryCost.toFixed(4)}, Max profit: $${maxProfit.toFixed(4)}, Max shares: ${maxShares.toFixed(2)}`);

    // Only filter out if not meeting profit threshold AND refs are different
    // Always include pairs with identical refs so user can see them
    if (!identicalRefs && maxProfit < this.minProfit) {
      debug(`  Rejected: profit $${maxProfit.toFixed(4)} < min $${this.minProfit.toFixed(4)}`);
      return null;
    }
    // Note: We no longer reject for maxShares <= 0 since we default to 1000 for missing sizes

    const profitZoneWidth = profitZoneHigh - profitZoneLow;
    const avgRef = (longRef + shortRef) / 2;
    const profitZonePercent = (profitZoneWidth / avgRef) * 100;

    const resolutionTime = new Date(longInfo.resolutionTimestamp * 1000);
    const minutesUntilResolution = (resolutionTime.getTime() - Date.now()) / 60000;

    return {
      longMarket: longInfo.market,
      shortMarket: shortInfo.market,
      longInterval: longInfo.interval,
      shortInterval: shortInfo.interval,
      longUpTokenId: longInfo.pair.yesTokenId,
      longDownTokenId: longInfo.pair.noTokenId,
      shortUpTokenId: shortInfo.pair.yesTokenId,
      shortDownTokenId: shortInfo.pair.noTokenId,
      longRefPrice: longRef,
      shortRefPrice: shortRef,
      profitZoneLow,
      profitZoneHigh,
      strategy,
      longUpAsk,
      longDownAsk,
      shortUpAsk,
      shortDownAsk,
      entryCost,
      maxProfit,
      profitZoneWidth,
      profitZonePercent,
      maxShares,
      resolutionTime,
      minutesUntilResolution,
      timestamp: new Date(),
    };
  }

  /**
   * Scan all markets for cross-market opportunities
   */
  scanAllCrossMarkets(): CrossMarketOpportunity[] {
    const opportunities: CrossMarketOpportunity[] = [];
    const checkedPairs = new Set<string>();

    // Group markets by asset and resolution time (5-minute buckets)
    const byAssetAndTime = new Map<string, MarketInfo[]>();

    for (const marketInfo of this.marketInfos.values()) {
      // Round resolution time to 5 minutes for grouping
      const roundedTime = Math.round(marketInfo.resolutionTimestamp / 300) * 300;
      const key = `${marketInfo.asset}-${roundedTime}`;

      if (!byAssetAndTime.has(key)) {
        byAssetAndTime.set(key, []);
      }
      byAssetAndTime.get(key)!.push(marketInfo);
    }

    debug(`scanAllCrossMarkets: Grouped ${this.marketInfos.size} markets into ${byAssetAndTime.size} time buckets (tokenPrices: ${this.tokenPrices.size})`);

    // Check each group for cross-market opportunities
    for (const [key, markets] of byAssetAndTime) {
      if (markets.length < 2) continue;

      const intervals = markets.map(m => m.interval);
      debug(`Bucket ${key}: ${markets.length} markets (${intervals.join(', ')})`);

      // Check all pairs within this group
      for (let i = 0; i < markets.length; i++) {
        for (let j = i + 1; j < markets.length; j++) {
          const info1 = markets[i]!;
          const info2 = markets[j]!;

          // Skip if same interval
          if (info1.interval === info2.interval) continue;

          const pairKey = [info1.market.slug, info2.market.slug].sort().join('|');
          if (checkedPairs.has(pairKey)) continue;
          checkedPairs.add(pairKey);

          debug(`Checking pair: ${info1.interval} vs ${info2.interval} for ${info1.asset.toUpperCase()}`);
          const opp = this.checkPairForArbitrage(info1, info2);
          if (opp) {
            debug(`  -> Found opportunity! Profit: $${opp.maxProfit.toFixed(4)}`);
            opportunities.push(opp);
          }
        }
      }
    }

    // Sort by profit descending
    return opportunities.sort((a, b) => b.maxProfit - a.maxProfit);
  }

  /**
   * Find the best near-miss cross-market opportunity
   */
  findBestCrossMarketNearMiss(): CrossMarketOpportunity | null {
    const opportunities = this.findAllCrossMarketOpportunities();
    if (opportunities.length === 0) return null;
    return opportunities[0]!;
  }

  /**
   * Find all cross-market opportunities (including near misses and identical ref pairs)
   * Returns all overlapping market pairs sorted by profit
   */
  findAllCrossMarketOpportunities(): CrossMarketOpportunity[] {
    // Temporarily lower minProfit to find all near misses (including identical ref pairs)
    const originalMinProfit = this.minProfit;
    this.minProfit = -2.0; // Allow any loss to find all pairs including identical refs

    const opportunities = this.scanAllCrossMarkets();

    this.minProfit = originalMinProfit;

    // Log diagnostic info about why we might not have opportunities
    if (opportunities.length === 0) {
      this.logMissingPairDiagnostics();
    }

    return opportunities;
  }

  /**
   * Get diagnostic info about what's missing for cross-market pairs
   */
  getDiagnosticInfo(): string {
    return this.logMissingPairDiagnostics();
  }

  /**
   * Log diagnostics about why cross-market pairs aren't being found
   * Returns a summary string for Telegram notifications
   */
  logMissingPairDiagnostics(): string {
    // Group markets by asset and resolution time
    const byAssetAndTime = new Map<string, MarketInfo[]>();

    for (const marketInfo of this.marketInfos.values()) {
      const roundedTime = Math.round(marketInfo.resolutionTimestamp / 300) * 300;
      const key = `${marketInfo.asset}-${roundedTime}`;

      if (!byAssetAndTime.has(key)) {
        byAssetAndTime.set(key, []);
      }
      byAssetAndTime.get(key)!.push(marketInfo);
    }

    let potentialPairs = 0;
    let missingRefPrices = 0;
    let missingTokenPrices = 0;
    const missingDetails: string[] = [];

    for (const [key, markets] of byAssetAndTime) {
      if (markets.length < 2) continue;

      // Check all pairs
      for (let i = 0; i < markets.length; i++) {
        for (let j = i + 1; j < markets.length; j++) {
          const m1 = markets[i]!;
          const m2 = markets[j]!;

          if (m1.interval === m2.interval) continue;

          potentialPairs++;

          // Check reference prices
          const hasRefs = m1.referencePrice !== null && m2.referencePrice !== null;
          if (!hasRefs) {
            missingRefPrices++;
            const missing = [];
            if (m1.referencePrice === null) missing.push(`${m1.interval}`);
            if (m2.referencePrice === null) missing.push(`${m2.interval}`);
            const detail = `${m1.asset.toUpperCase()} ${m1.interval}/${m2.interval}: need ref for ${missing.join(', ')}`;
            missingDetails.push(detail);
            info(`Pair ${m1.asset.toUpperCase()} ${m1.interval}/${m2.interval}: Missing ref prices for ${missing.map(i => `${i}(${i === m1.interval ? m1.market.slug : m2.market.slug})`).join(', ')}`);
            continue;
          }

          // Check token prices
          const m1YesPrice = this.tokenPrices.get(m1.pair.yesTokenId);
          const m1NoPrice = this.tokenPrices.get(m1.pair.noTokenId);
          const m2YesPrice = this.tokenPrices.get(m2.pair.yesTokenId);
          const m2NoPrice = this.tokenPrices.get(m2.pair.noTokenId);

          const missingTokens = [];
          if (!m1YesPrice?.bestAsk) missingTokens.push(`${m1.interval}-UP`);
          if (!m1NoPrice?.bestAsk) missingTokens.push(`${m1.interval}-DOWN`);
          if (!m2YesPrice?.bestAsk) missingTokens.push(`${m2.interval}-UP`);
          if (!m2NoPrice?.bestAsk) missingTokens.push(`${m2.interval}-DOWN`);

          if (missingTokens.length > 0) {
            missingTokenPrices++;
            const detail = `${m1.asset.toUpperCase()} ${m1.interval}/${m2.interval}: need asks for ${missingTokens.join(', ')}`;
            missingDetails.push(detail);
            info(`Pair ${m1.asset.toUpperCase()} ${m1.interval}/${m2.interval}: Missing asks for ${missingTokens.join(', ')}`);
          }
        }
      }
    }

    const summary = `${potentialPairs} pairs: ${missingRefPrices} missing refs, ${missingTokenPrices} missing asks`;
    if (potentialPairs > 0) {
      info(`Cross-market diagnostics: ${summary}`);
    }

    // Return detailed info for Telegram (first 3 issues)
    if (missingDetails.length > 0) {
      return missingDetails.slice(0, 3).join('\n');
    }
    return summary;
  }

  /**
   * Get all registered token IDs
   */
  getAllTokenIds(): string[] {
    const tokenIds: string[] = [];
    for (const info of this.marketInfos.values()) {
      tokenIds.push(info.pair.yesTokenId, info.pair.noTokenId);
    }
    return tokenIds;
  }

  /**
   * Get market summary data for Telegram notifications
   */
  getMarketSummaryData(): Array<{
    asset: string;
    interval: string;
    minutesUntilResolution: number;
    referencePrice: number | null;
    upBestAsk: number | null;
    upBestBid: number | null;
    downBestAsk: number | null;
    downBestBid: number | null;
  }> {
    const data: Array<{
      asset: string;
      interval: string;
      minutesUntilResolution: number;
      referencePrice: number | null;
      upBestAsk: number | null;
      upBestBid: number | null;
      downBestAsk: number | null;
      downBestBid: number | null;
    }> = [];

    for (const marketInfo of this.marketInfos.values()) {
      const resolutionTime = new Date(marketInfo.resolutionTimestamp * 1000);
      const minutesUntilResolution = (resolutionTime.getTime() - Date.now()) / 60000;

      // Skip markets that have already resolved
      if (minutesUntilResolution < 0) continue;

      const upPrice = this.tokenPrices.get(marketInfo.pair.yesTokenId);
      const downPrice = this.tokenPrices.get(marketInfo.pair.noTokenId);

      data.push({
        asset: marketInfo.asset,
        interval: marketInfo.interval,
        minutesUntilResolution,
        referencePrice: marketInfo.referencePrice,
        upBestAsk: upPrice?.bestAsk ?? null,
        upBestBid: upPrice?.bestBid ?? null,
        downBestAsk: downPrice?.bestAsk ?? null,
        downBestBid: downPrice?.bestBid ?? null,
      });
    }

    return data;
  }

  /**
   * Get stats
   */
  getStats(): { marketsTracked: number; tokensWithPrices: number; crossPairsFound: number } {
    // Count potential cross-market pairs
    const byAssetAndTime = new Map<string, MarketInfo[]>();

    for (const info of this.marketInfos.values()) {
      const roundedTime = Math.round(info.resolutionTimestamp / 60) * 60;
      const key = `${info.asset}-${roundedTime}`;

      if (!byAssetAndTime.has(key)) {
        byAssetAndTime.set(key, []);
      }
      byAssetAndTime.get(key)!.push(info);
    }

    let crossPairs = 0;
    for (const markets of byAssetAndTime.values()) {
      if (markets.length >= 2) {
        // Count unique interval pairs
        const intervals = new Set(markets.map(m => m.interval));
        if (intervals.size >= 2) {
          crossPairs += intervals.size * (intervals.size - 1) / 2;
        }
      }
    }

    return {
      marketsTracked: this.marketInfos.size,
      tokensWithPrices: this.tokenPrices.size,
      crossPairsFound: crossPairs,
    };
  }
}
