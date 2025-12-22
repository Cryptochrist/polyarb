import { fetchAllActiveMarkets, createMarketPairs, fetchCryptoMarkets, fetchShortDurationMarkets } from './gammaApi.js';
import { fetchMultipleOrderBooks } from './clobApi.js';
import { PolymarketWebSocket, type ParsedBookUpdate } from './websocket.js';
import { ArbitrageDetector } from './arbDetector.js';
import { ArbitrageExecutor, type ExecutorConfig } from './executor.js';
import { DEFAULT_CONFIG } from './config.js';
import type { ArbitrageOpportunity, MarketPair, ScannerConfig } from './types.js';
import { info, warn, error, logArbitrage, logStats, debug } from './logger.js';
import { notifyOpportunity, notifyStartup } from './telegram.js';

export type MarketMode = 'all' | 'crypto' | 'short';

export interface ScannerOptions {
  config?: Partial<ScannerConfig>;
  executorConfig?: ExecutorConfig;
  mode?: MarketMode;
  maxHours?: number;  // For 'short' mode
}

export class PolyArbScanner {
  private config: ScannerConfig;
  private detector: ArbitrageDetector;
  private websocket: PolymarketWebSocket;
  private executor: ArbitrageExecutor | null = null;
  private marketPairs: MarketPair[] = [];
  private isRunning = false;
  private startTime: Date | null = null;
  private opportunitiesFound = 0;
  private statsInterval: NodeJS.Timeout | null = null;
  private marketRefreshInterval: NodeJS.Timeout | null = null;
  private executionEnabled = false;
  private isExecuting = false; // Prevent concurrent executions
  private mode: MarketMode;
  private maxHours: number;

  constructor(options: ScannerOptions = {}) {
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.detector = new ArbitrageDetector(this.config);
    this.websocket = new PolymarketWebSocket();
    this.mode = options.mode ?? 'all';
    this.maxHours = options.maxHours ?? 24;

    if (options.executorConfig) {
      this.executor = new ArbitrageExecutor(options.executorConfig);
      this.executionEnabled = true;
    }

    this.setupWebSocketHandlers();
  }

  private setupWebSocketHandlers(): void {
    this.websocket.on('book', (update: ParsedBookUpdate) => {
      const opp = this.detector.updateFromWebSocket(update);
      if (opp) {
        this.handleOpportunity(opp);
      }
    });

    this.websocket.on('price', (update: ParsedBookUpdate) => {
      const opp = this.detector.updateFromWebSocket(update);
      if (opp) {
        this.handleOpportunity(opp);
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

      // Step 6: Do initial scan
      const opportunities = this.detector.scanAllMarkets();
      if (opportunities.length > 0) {
        info(`Found ${opportunities.length} opportunities on initial scan`);
        for (const opp of opportunities) {
          this.handleOpportunity(opp);
        }
      } else {
        info('No arbitrage opportunities found on initial scan');
      }

      info('Scanner running - monitoring for arbitrage opportunities...');

      // Send Telegram startup notification
      notifyStartup(this.marketPairs.length, this.mode).catch(() => {});
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
      default:
        markets = await fetchAllActiveMarkets(this.config.minLiquidity, 500);
    }

    this.marketPairs = createMarketPairs(markets);
    this.detector.setMarketPairs(this.marketPairs);
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
    this.marketRefreshInterval = setInterval(async () => {
      try {
        debug('Periodic market refresh...');
        const oldCount = this.marketPairs.length;
        await this.refreshMarkets();

        // Subscribe to any new tokens
        const newTokens = this.detector.getAllTokenIds().filter(
          (id) => !this.websocket.getSubscribedCount()
        );

        if (newTokens.length > 0) {
          this.websocket.subscribeToTokens(newTokens);
          info(`Subscribed to ${newTokens.length} new token streams`);
        }

        if (this.marketPairs.length !== oldCount) {
          info(`Market count changed: ${oldCount} -> ${this.marketPairs.length}`);
        }
      } catch (err) {
        error('Failed to refresh markets', err);
      }
    }, this.config.scanIntervalMs * 12); // Refresh every ~1 minute
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
