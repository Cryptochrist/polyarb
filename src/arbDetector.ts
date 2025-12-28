import type { ArbitrageOpportunity, GammaMarket, MarketPair, OrderBook, ScannerConfig } from './types.js';
import type { ParsedBookUpdate } from './websocket.js';
import { getBestAsk, getBestBid } from './clobApi.js';
import { debug } from './logger.js';

export type OpportunityType = 'BUY_BOTH' | 'SELL_BOTH';

export interface ExtendedOpportunity extends ArbitrageOpportunity {
  type: OpportunityType;
  yesBidPrice?: number;
  noBidPrice?: number;
  yesBidSize?: number;
  noBidSize?: number;
}

interface TokenPrice {
  bestAsk: number | null;
  bestAskSize: number | null;
  bestBid: number | null;
  bestBidSize: number | null;
  lastUpdate: Date;
}

export interface NearMissOpportunity {
  market: import('./types.js').GammaMarket;
  type: OpportunityType;
  totalCost: number;      // For BUY_BOTH: sum of asks
  totalBids: number;      // For SELL_BOTH: sum of bids
  profitGap: number;      // How far from profitable (negative = loss)
  yesPrice: number;
  noPrice: number;
  maxShares: number;
  timestamp: Date;
}

export class ArbitrageDetector {
  private config: ScannerConfig;
  private marketPairs: Map<string, MarketPair> = new Map(); // tokenId -> MarketPair
  private tokenPrices: Map<string, TokenPrice> = new Map(); // tokenId -> price data
  private marketLookup: Map<string, MarketPair> = new Map(); // marketId -> MarketPair
  private bestNearMiss: NearMissOpportunity | null = null;

  constructor(config: ScannerConfig) {
    this.config = config;
  }

  setMarketPairs(pairs: MarketPair[]): void {
    this.marketPairs.clear();
    this.marketLookup.clear();

    for (const pair of pairs) {
      this.marketPairs.set(pair.yesTokenId, pair);
      this.marketPairs.set(pair.noTokenId, pair);
      this.marketLookup.set(pair.market.id, pair);
    }

    debug(`ArbitrageDetector tracking ${pairs.length} market pairs`);
  }

  updateFromOrderBook(tokenId: string, book: OrderBook): ExtendedOpportunity | null {
    const bestAsk = getBestAsk(book);
    const bestBid = getBestBid(book);

    this.tokenPrices.set(tokenId, {
      bestAsk: bestAsk?.price ?? null,
      bestAskSize: bestAsk?.size ?? null,
      bestBid: bestBid?.price ?? null,
      bestBidSize: bestBid?.size ?? null,
      lastUpdate: new Date(),
    });

    return this.checkAllArbitrageTypes(tokenId);
  }

  updateFromWebSocket(update: ParsedBookUpdate): ExtendedOpportunity | null {
    const existing = this.tokenPrices.get(update.tokenId);

    this.tokenPrices.set(update.tokenId, {
      bestAsk: update.bestAsk ?? existing?.bestAsk ?? null,
      bestAskSize: update.bestAskSize ?? existing?.bestAskSize ?? null,
      bestBid: update.bestBid ?? existing?.bestBid ?? null,
      bestBidSize: update.bestBidSize ?? existing?.bestBidSize ?? null,
      lastUpdate: update.timestamp,
    });

    return this.checkAllArbitrageTypes(update.tokenId);
  }

  // Check for both BUY_BOTH and SELL_BOTH opportunities
  private checkAllArbitrageTypes(tokenId: string): ExtendedOpportunity | null {
    // First check BUY_BOTH (most common)
    const buyBoth = this.checkBuyBothArbitrage(tokenId);
    if (buyBoth) return buyBoth;

    // Then check SELL_BOTH (when bids sum > $1.00)
    const sellBoth = this.checkSellBothArbitrage(tokenId);
    if (sellBoth) return sellBoth;

    return null;
  }

  // BUY_BOTH: Buy YES + NO when asks sum < $1.00
  private checkBuyBothArbitrage(tokenId: string): ExtendedOpportunity | null {
    const pair = this.marketPairs.get(tokenId);
    if (!pair) return null;

    const yesPrice = this.tokenPrices.get(pair.yesTokenId);
    const noPrice = this.tokenPrices.get(pair.noTokenId);

    if (!yesPrice?.bestAsk || !noPrice?.bestAsk) return null;

    const totalCost = yesPrice.bestAsk + noPrice.bestAsk;
    const profit = 1.0 - totalCost;

    if (profit < this.config.minProfit) return null;
    if (pair.market.liquidityNum < this.config.minLiquidity) return null;

    const yesSize = yesPrice.bestAskSize ?? 0;
    const noSize = noPrice.bestAskSize ?? 0;
    const maxShares = Math.min(yesSize, noSize);

    if (maxShares <= 0) return null;

    return {
      type: 'BUY_BOTH',
      market: pair.market,
      yesAskPrice: yesPrice.bestAsk,
      noAskPrice: noPrice.bestAsk,
      yesBidPrice: yesPrice.bestBid ?? undefined,
      noBidPrice: noPrice.bestBid ?? undefined,
      totalCost,
      profit,
      profitPercent: profit / totalCost,
      yesAskSize: yesSize,
      noAskSize: noSize,
      yesBidSize: yesPrice.bestBidSize ?? undefined,
      noBidSize: noPrice.bestBidSize ?? undefined,
      maxShares,
      timestamp: new Date(),
    };
  }

  // SELL_BOTH: Sell YES + NO when bids sum > $1.00 (mint for $1, sell for more)
  private checkSellBothArbitrage(tokenId: string): ExtendedOpportunity | null {
    const pair = this.marketPairs.get(tokenId);
    if (!pair) return null;

    const yesPrice = this.tokenPrices.get(pair.yesTokenId);
    const noPrice = this.tokenPrices.get(pair.noTokenId);

    if (!yesPrice?.bestBid || !noPrice?.bestBid) return null;

    const totalBids = yesPrice.bestBid + noPrice.bestBid;
    const profit = totalBids - 1.0; // Mint costs $1, sell for totalBids

    if (profit < this.config.minProfit) return null;
    if (pair.market.liquidityNum < this.config.minLiquidity) return null;

    const yesSize = yesPrice.bestBidSize ?? 0;
    const noSize = noPrice.bestBidSize ?? 0;
    const maxShares = Math.min(yesSize, noSize);

    if (maxShares <= 0) return null;

    return {
      type: 'SELL_BOTH',
      market: pair.market,
      yesAskPrice: yesPrice.bestAsk ?? 0,
      noAskPrice: noPrice.bestAsk ?? 0,
      yesBidPrice: yesPrice.bestBid,
      noBidPrice: noPrice.bestBid,
      totalCost: 1.0,
      profit,
      profitPercent: profit,
      yesAskSize: yesPrice.bestAskSize ?? 0,
      noAskSize: noPrice.bestAskSize ?? 0,
      yesBidSize: yesSize,
      noBidSize: noSize,
      maxShares,
      timestamp: new Date(),
    };
  }

  // Scan all markets for ALL opportunity types
  scanAllMarkets(): ExtendedOpportunity[] {
    const opportunities: ExtendedOpportunity[] = [];
    const checkedMarkets = new Set<string>();

    for (const [tokenId, pair] of this.marketPairs) {
      // Skip if we already checked this market
      if (checkedMarkets.has(pair.market.id)) {
        continue;
      }
      checkedMarkets.add(pair.market.id);

      const opp = this.checkAllArbitrageTypes(tokenId);
      if (opp) {
        opportunities.push(opp);
      }
    }

    // Sort by profit descending
    return opportunities.sort((a, b) => b.profit - a.profit);
  }

  getMarketPair(marketId: string): MarketPair | undefined {
    return this.marketLookup.get(marketId);
  }

  getAllTokenIds(): string[] {
    return [...this.marketPairs.keys()];
  }

  getStats(): { marketsTracked: number; tokensWithPrices: number } {
    return {
      marketsTracked: this.marketLookup.size,
      tokensWithPrices: this.tokenPrices.size,
    };
  }

  // Find the closest-to-profitable opportunity across all markets
  findBestNearMiss(): NearMissOpportunity | null {
    let bestNearMiss: NearMissOpportunity | null = null;
    const checkedMarkets = new Set<string>();

    for (const [tokenId, pair] of this.marketPairs) {
      if (checkedMarkets.has(pair.market.id)) continue;
      checkedMarkets.add(pair.market.id);

      const yesPrice = this.tokenPrices.get(pair.yesTokenId);
      const noPrice = this.tokenPrices.get(pair.noTokenId);

      // Check BUY_BOTH near miss (asks sum close to $1.00)
      if (yesPrice?.bestAsk && noPrice?.bestAsk) {
        const totalCost = yesPrice.bestAsk + noPrice.bestAsk;
        const profitGap = 1.0 - totalCost; // positive = profitable, negative = loss
        const yesSize = yesPrice.bestAskSize ?? 0;
        const noSize = noPrice.bestAskSize ?? 0;
        const maxShares = Math.min(yesSize, noSize);

        if (maxShares > 0 && pair.market.liquidityNum >= this.config.minLiquidity) {
          if (!bestNearMiss || profitGap > bestNearMiss.profitGap) {
            bestNearMiss = {
              market: pair.market,
              type: 'BUY_BOTH',
              totalCost,
              totalBids: (yesPrice.bestBid ?? 0) + (noPrice.bestBid ?? 0),
              profitGap,
              yesPrice: yesPrice.bestAsk,
              noPrice: noPrice.bestAsk,
              maxShares,
              timestamp: new Date(),
            };
          }
        }
      }

      // Check SELL_BOTH near miss (bids sum close to $1.00)
      if (yesPrice?.bestBid && noPrice?.bestBid) {
        const totalBids = yesPrice.bestBid + noPrice.bestBid;
        const profitGap = totalBids - 1.0; // positive = profitable, negative = loss
        const yesSize = yesPrice.bestBidSize ?? 0;
        const noSize = noPrice.bestBidSize ?? 0;
        const maxShares = Math.min(yesSize, noSize);

        if (maxShares > 0 && pair.market.liquidityNum >= this.config.minLiquidity) {
          if (!bestNearMiss || profitGap > bestNearMiss.profitGap) {
            bestNearMiss = {
              market: pair.market,
              type: 'SELL_BOTH',
              totalCost: 1.0,
              totalBids,
              profitGap,
              yesPrice: yesPrice.bestBid,
              noPrice: noPrice.bestBid,
              maxShares,
              timestamp: new Date(),
            };
          }
        }
      }
    }

    this.bestNearMiss = bestNearMiss;
    return bestNearMiss;
  }

  getBestNearMiss(): NearMissOpportunity | null {
    return this.bestNearMiss;
  }

  resetBestNearMiss(): void {
    this.bestNearMiss = null;
  }

  // Clear stale price data (older than specified ms)
  clearStaleData(maxAgeMs: number = 60000): void {
    const now = Date.now();
    for (const [tokenId, price] of this.tokenPrices) {
      if (now - price.lastUpdate.getTime() > maxAgeMs) {
        this.tokenPrices.delete(tokenId);
      }
    }
  }
}
