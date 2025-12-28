import { fetchAllActiveMarkets, createMarketPairs, fetchCryptoMarkets, fetchShortDurationMarkets, fetchAllCryptoUpDownMarkets, type BTCMarketInterval } from './gammaApi.js';
import { fetchMultipleOrderBooks } from './clobApi.js';
import { PolymarketWebSocket, type ParsedBookUpdate } from './websocket.js';
import { ArbitrageDetector } from './arbDetector.js';
import { CrossMarketDetector, type CrossMarketOpportunity } from './crossMarketDetector.js';
import { ArbitrageExecutor, type ExecutorConfig } from './executor.js';
import { DEFAULT_CONFIG } from './config.js';
import type { ArbitrageOpportunity, MarketPair, ScannerConfig } from './types.js';
import { info, warn, error, logArbitrage, logStats, debug } from './logger.js';
import { notifyOpportunity, notifyStartup, notifyCrossMarketOpportunity, notifyCrossMarketNearMiss, notifyMarketSummary, type MarketSummaryData } from './telegram.js';

export type MarketMode = 'all' | 'crypto' | 'short' | 'updown';

export interface ScannerOptions {
  config?: Partial<ScannerConfig>;
  executorConfig?: ExecutorConfig;
  mode?: MarketMode;
  maxHours?: number;  // For 'short' mode
  intervals?: BTCMarketInterval[];  // For 'updown' mode: which intervals to track
}

export class PolyArbScanner {
  private config: ScannerConfig;
  private detector: ArbitrageDetector;
  private crossMarketDetector: CrossMarketDetector;
  private websocket: PolymarketWebSocket;
  private executor: ArbitrageExecutor | null = null;
  private marketPairs: MarketPair[] = [];
  private isRunning = false;
  private startTime: Date | null = null;
  private opportunitiesFound = 0;
  private crossMarketOpportunitiesFound = 0;
  private statsInterval: NodeJS.Timeout | null = null;
  private marketRefreshInterval: NodeJS.Timeout | null = null;
  private nearMissInterval: NodeJS.Timeout | null = null;
  private executionEnabled = false;
  private isExecuting = false; // Prevent concurrent executions
  private mode: MarketMode;
  private maxHours: number;
  private intervals: BTCMarketInterval[];

  constructor(options: ScannerOptions = {}) {
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.detector = new ArbitrageDetector(this.config);
    this.crossMarketDetector = new CrossMarketDetector(this.config.minProfit);
    this.websocket = new PolymarketWebSocket();
    this.mode = options.mode ?? 'all';
    this.maxHours = options.maxHours ?? 24;
    this.intervals = options.intervals ?? ['15m', '1h', '4h', '1d'];

    if (options.executorConfig) {
      this.executor = new ArbitrageExecutor(options.executorConfig);
      this.executionEnabled = true;
    }

    this.setupWebSocketHandlers();
  }

  private setupWebSocketHandlers(): void {
    this.websocket.on('book', (update: ParsedBookUpdate) => {
      // Check single-market arbitrage
      const opp = this.detector.updateFromWebSocket(update);
      if (opp) {
        this.handleOpportunity(opp);
      }

      // Check cross-market arbitrage (only in updown mode)
      if (this.mode === 'updown') {
        const crossOpp = this.crossMarketDetector.updateFromWebSocket(update);
        if (crossOpp) {
          this.handleCrossMarketOpportunity(crossOpp);
        }
      }
    });

    this.websocket.on('price', (update: ParsedBookUpdate) => {
      // Check single-market arbitrage
      const opp = this.detector.updateFromWebSocket(update);
      if (opp) {
        this.handleOpportunity(opp);
      }

      // Check cross-market arbitrage (only in updown mode)
      if (this.mode === 'updown') {
        const crossOpp = this.crossMarketDetector.updateFromWebSocket(update);
        if (crossOpp) {
          this.handleCrossMarketOpportunity(crossOpp);
        }
      }
    });

    this.websocket.on('connected', () => {
      info('WebSocket reconnected - resubscribing to all tokens');
    });

    this.websocket.on('disconnected', () => {
      warn('WebSocket disconnected - will attempt reconnection');
    });

    this.websocket.on('error', (err: Error) => {
      error('WebSocket error', err);
    });
  }

  private async handleOpportunity(opp: ArbitrageOpportunity): Promise<void> {
    this.opportunitiesFound++;
    logArbitrage(opp);

    // Send Telegram notification
    notifyOpportunity(opp).catch((err) => error('Telegram notification failed', err));

    // Execute if enabled and not already executing
    if (this.executionEnabled && this.executor && !this.isExecuting) {
      this.isExecuting = true;
      try {
        const result = await this.executor.executeArbitrage(opp);
        if (result.success) {
          info(`Trade executed: ${result.sharesTraded.toFixed(2)} shares, profit: $${result.expectedProfit.toFixed(4)}`);
        } else if (result.error) {
          warn(`Trade failed: ${result.error}`);
        }
      } catch (err) {
        error('Execution error', err);
      } finally {
        this.isExecuting = false;
      }
    }
  }

  private async handleCrossMarketOpportunity(opp: CrossMarketOpportunity): Promise<void> {
    this.crossMarketOpportunitiesFound++;

    const strategyStr = opp.strategy === 'LONG_DOWN_SHORT_UP'
      ? `${opp.longInterval} DOWN + ${opp.shortInterval} UP`
      : `${opp.longInterval} UP + ${opp.shortInterval} DOWN`;

    info(`CROSS-MARKET ARB: ${opp.longMarket.slug.split('-')[0]!.toUpperCase()} | ${strategyStr}`);
    info(`  Refs: $${opp.longRefPrice.toLocaleString()} vs $${opp.shortRefPrice.toLocaleString()}`);
    info(`  Zone: $${opp.profitZoneLow.toLocaleString()} - $${opp.profitZoneHigh.toLocaleString()} (${opp.profitZonePercent.toFixed(3)}%)`);
    info(`  Entry: $${opp.entryCost.toFixed(4)} | Profit: $${opp.maxProfit.toFixed(4)}/share | Max: ${opp.maxShares.toFixed(2)} shares`);
    info(`  Resolves in: ${opp.minutesUntilResolution.toFixed(1)} minutes`);

    // Send Telegram notification
    notifyCrossMarketOpportunity(opp).catch((err) => error('Telegram notification failed', err));

    // TODO: Execute cross-market trades if enabled
    // This requires buying positions on two different markets simultaneously
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      warn('Scanner is already running');
      return;
    }

    info('Starting PolyArb Scanner...');
    info(`Config: minProfit=$${this.config.minProfit}, minLiquidity=$${this.config.minLiquidity}`);

    // Initialize executor if configured
    if (this.executor) {
      await this.executor.initialize();
      info(`Execution ${this.executor.isReady() ? 'ENABLED' : 'DISABLED'}`);
    }

    this.isRunning = true;
    this.startTime = new Date();

    try {
      // Step 1: Discover all markets via REST
      await this.refreshMarkets();

      // Step 2: Initial orderbook fetch for all tokens
      await this.fetchAllOrderBooks();

      // Step 3: Connect WebSocket for real-time updates
      await this.connectWebSocket();

      // Step 4: Start periodic market refresh (new markets, closed markets)
      this.startMarketRefresh();

      // Step 5: Start stats logging
      this.startStatsLogging();

      // Step 6: Start 10-minute near-miss reporting
      this.startNearMissReporting();

      // Step 7: Do initial scan for single-market arbitrage
      const opportunities = this.detector.scanAllMarkets();
      if (opportunities.length > 0) {
        info(`Found ${opportunities.length} single-market opportunities on initial scan`);
        for (const opp of opportunities) {
          this.handleOpportunity(opp);
        }
      } else {
        info('No single-market arbitrage opportunities found on initial scan');
      }

      // Step 8: Do initial scan for cross-market arbitrage (updown mode only)
      if (this.mode === 'updown') {
        // Load reference prices from Polymarket for cross-market detection
        await this.crossMarketDetector.loadReferencePrices();

        const crossOpportunities = this.crossMarketDetector.scanAllCrossMarkets();
        if (crossOpportunities.length > 0) {
          info(`Found ${crossOpportunities.length} cross-market opportunities on initial scan`);
          for (const opp of crossOpportunities) {
            this.handleCrossMarketOpportunity(opp);
          }
        } else {
          info('No cross-market arbitrage opportunities found on initial scan');
        }

        // Send initial market summary to Telegram
        const marketData = this.crossMarketDetector.getMarketSummaryData();
        info(`Sending initial market summary: ${marketData.length} markets`);
        await notifyMarketSummary(marketData, 0);
      }

      info('Scanner running - monitoring for arbitrage opportunities...');

      // Send Telegram startup notification (for non-updown modes)
      if (this.mode !== 'updown') {
        notifyStartup(this.marketPairs.length, this.mode).catch(() => {});
      }
    } catch (err) {
      error('Failed to start scanner', err);
      this.stop();
      throw err;
    }
  }

  private async refreshMarkets(): Promise<void> {
    info(`Refreshing market list (mode: ${this.mode})...`);

    let markets;
    switch (this.mode) {
      case 'crypto':
        markets = await fetchCryptoMarkets({
          minLiquidity: this.config.minLiquidity,
          maxMarkets: 200,
        });
        break;
      case 'short':
        markets = await fetchShortDurationMarkets(this.maxHours, this.config.minLiquidity);
        break;
      case 'updown':
        // Fetch all crypto up/down markets (BTC, ETH, XRP, SOL)
        // For each asset: 15m, 1h, 4h, 1d intervals (4 markets each)
        markets = await fetchAllCryptoUpDownMarkets(this.intervals);
        break;
      default:
        markets = await fetchAllActiveMarkets(this.config.minLiquidity, 500);
    }

    this.marketPairs = createMarketPairs(markets);
    this.detector.setMarketPairs(this.marketPairs);

    // Also update cross-market detector for updown mode
    if (this.mode === 'updown') {
      this.crossMarketDetector.setMarketPairs(this.marketPairs);
      const crossStats = this.crossMarketDetector.getStats();
      info(`Cross-market detector: ${crossStats.marketsTracked} markets, ${crossStats.crossPairsFound} potential cross-pairs`);
    }

    info(`Tracking ${this.marketPairs.length} binary markets`);
  }

  private async fetchAllOrderBooks(): Promise<void> {
    const tokenIds = this.detector.getAllTokenIds();
    info(`Fetching orderbooks for ${tokenIds.length} tokens...`);

    const orderBooks = await fetchMultipleOrderBooks(
      tokenIds,
      this.config.maxConcurrentRequests
    );

    for (const [tokenId, book] of orderBooks) {
      this.detector.updateFromOrderBook(tokenId, book);

      // Also update cross-market detector in updown mode
      if (this.mode === 'updown') {
        this.crossMarketDetector.updateFromOrderBook(tokenId, book);
      }
    }

    info(`Loaded ${orderBooks.size} orderbooks`);
  }

  private async connectWebSocket(): Promise<void> {
    await this.websocket.connect();

    // Subscribe to all token IDs in batches
    const tokenIds = this.detector.getAllTokenIds();
    const batchSize = 100;

    for (let i = 0; i < tokenIds.length; i += batchSize) {
      const batch = tokenIds.slice(i, i + batchSize);
      this.websocket.subscribeToTokens(batch);

      // Small delay between batches
      if (i + batchSize < tokenIds.length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    info(`Subscribed to ${tokenIds.length} token streams`);
  }

  private startMarketRefresh(): void {
    // Refresh market list periodically to catch new markets
    // For 'updown' mode, refresh more frequently since markets change every 15 minutes
    const refreshInterval = this.mode === 'updown'
      ? 30000  // 30 seconds for updown mode (new markets every 15m)
      : this.config.scanIntervalMs * 12; // ~1 minute for other modes

    this.marketRefreshInterval = setInterval(async () => {
      try {
        debug('Periodic market refresh...');
        const oldCount = this.marketPairs.length;
        const oldSlugs = new Set(this.marketPairs.map(p => p.market.slug));

        await this.refreshMarkets();

        // Find truly new tokens (not already subscribed)
        const newTokens: string[] = [];

        for (const pair of this.marketPairs) {
          // If this is a new market we weren't tracking before
          if (!oldSlugs.has(pair.market.slug)) {
            newTokens.push(pair.yesTokenId, pair.noTokenId);
          }
        }

        if (newTokens.length > 0) {
          // Fetch orderbooks for new tokens
          const orderBooks = await fetchMultipleOrderBooks(newTokens, this.config.maxConcurrentRequests);
          for (const [tokenId, book] of orderBooks) {
            this.detector.updateFromOrderBook(tokenId, book);

            // Also update cross-market detector in updown mode
            if (this.mode === 'updown') {
              this.crossMarketDetector.updateFromOrderBook(tokenId, book);
            }
          }

          this.websocket.subscribeToTokens(newTokens);
          info(`Subscribed to ${newTokens.length} new token streams (${newTokens.length / 2} new markets)`);
        }

        // In updown mode, reload any missing reference prices
        // This picks up prices for 15m candles that just started
        if (this.mode === 'updown') {
          await this.crossMarketDetector.loadReferencePrices();
        }

        if (this.marketPairs.length !== oldCount) {
          info(`Market count changed: ${oldCount} -> ${this.marketPairs.length}`);
        }
      } catch (err) {
        error('Failed to refresh markets', err);
      }
    }, refreshInterval);
  }

  private startStatsLogging(): void {
    this.statsInterval = setInterval(() => {
      const uptime = this.startTime ? Date.now() - this.startTime.getTime() : 0;
      const stats = this.detector.getStats();

      logStats(
        stats.marketsTracked,
        this.opportunitiesFound,
        this.websocket.getIsConnected(),
        uptime
      );
    }, 30000); // Log stats every 30 seconds
  }

  private startNearMissReporting(): void {
    // Send update every 5 minutes with market summary
    this.nearMissInterval = setInterval(async () => {
      try {
        const uptime = this.startTime ? Date.now() - this.startTime.getTime() : 0;

        if (this.mode === 'updown') {
          // Reload any missing reference prices (new 15m candles may have started)
          await this.crossMarketDetector.loadReferencePrices();

          // Get market summary data and send to Telegram
          const marketData = this.crossMarketDetector.getMarketSummaryData();
          info(`Sending 5-minute market summary: ${marketData.length} markets`);

          await notifyMarketSummary(marketData, uptime);
        } else {
          // For non-updown modes, send the old-style update
          const stats = this.detector.getStats();
          const singleMarketNearMiss = this.detector.findBestNearMiss();

          await notifyCrossMarketNearMiss(
            null,
            singleMarketNearMiss,
            stats.marketsTracked,
            0,
            uptime,
            [],
            undefined
          );
        }
      } catch (err) {
        error('Failed to send 5-minute update', err);
      }
    }, 5 * 60 * 1000); // 5 minutes
  }

  stop(): void {
    if (!this.isRunning) {
      return;
    }

    info('Stopping PolyArb Scanner...');
    this.isRunning = false;

    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    if (this.marketRefreshInterval) {
      clearInterval(this.marketRefreshInterval);
      this.marketRefreshInterval = null;
    }

    if (this.nearMissInterval) {
      clearInterval(this.nearMissInterval);
      this.nearMissInterval = null;
    }

    this.websocket.disconnect();
    info('Scanner stopped');
  }

  getStats(): {
    isRunning: boolean;
    uptime: number;
    marketsTracked: number;
    opportunitiesFound: number;
    wsConnected: boolean;
  } {
    return {
      isRunning: this.isRunning,
      uptime: this.startTime ? Date.now() - this.startTime.getTime() : 0,
      marketsTracked: this.detector.getStats().marketsTracked,
      opportunitiesFound: this.opportunitiesFound,
      wsConnected: this.websocket.getIsConnected(),
    };
  }
}
