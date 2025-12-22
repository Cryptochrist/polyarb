// Polymarket API Types

export interface GammaMarket {
  id: string;
  question: string;
  slug: string;
  conditionId: string;
  clobTokenIds: string[];
  outcomes: string[];
  outcomePrices: string[];
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

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface OrderBook {
  market: string;
  asset_id: string;
  timestamp: string;
  hash: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  min_order_size: string;
  tick_size: string;
  neg_risk: boolean;
}

export interface MarketPair {
  market: GammaMarket;
  yesTokenId: string;
  noTokenId: string;
}

export interface ArbitrageOpportunity {
  market: GammaMarket;
  yesAskPrice: number;
  noAskPrice: number;
  totalCost: number;
  profit: number;
  profitPercent: number;
  yesAskSize: number;
  noAskSize: number;
  maxShares: number;
  timestamp: Date;
}

export interface PriceUpdate {
  tokenId: string;
  bestBid: number;
  bestAsk: number;
  timestamp: Date;
}

export interface ScannerConfig {
  minProfit: number;           // Minimum profit threshold (e.g., 0.01 = 1 cent)
  minLiquidity: number;        // Minimum liquidity in USD
  scanIntervalMs: number;      // REST polling interval
  maxConcurrentRequests: number;
}

export interface RiskConfig {
  maxPositionPerMarket: number;  // Max USD per single market ($200 recommended)
  maxGlobalExposure: number;     // Total portfolio limit ($5000 recommended)
  maxDailyLoss: number;          // Stop trading if daily loss exceeds this ($500)
  enableKillSwitch: boolean;     // Emergency stop all trading
}

export interface ArbOpportunityType {
  type: 'buy_both' | 'sell_both' | 'spread';
  description: string;
}

// Extended opportunity with more details
export interface EnhancedArbitrageOpportunity extends ArbitrageOpportunity {
  opportunityType: ArbOpportunityType;
  yesBidPrice: number;
  noBidPrice: number;
  yesBidSize: number;
  noBidSize: number;
  spread: number;              // Ask - Bid spread
  urgency: 'low' | 'medium' | 'high';  // Based on how fast prices are moving
}
