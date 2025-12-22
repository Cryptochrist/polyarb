import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import type { ArbitrageOpportunity } from './types.js';
import { info, warn, error, debug } from './logger.js';

export interface ExecutorConfig {
  privateKey: string;
  funderAddress: string;      // Your Polymarket profile address
  signatureType: 0 | 1 | 2;   // 0=EOA, 1=Magic/Email, 2=Browser/Gnosis
  maxPositionSize: number;    // Max USD per trade
  dryRun: boolean;            // If true, log but don't execute
}

interface TradeResult {
  success: boolean;
  yesOrderId?: string;
  noOrderId?: string;
  error?: string;
  sharesTraded: number;
  totalCost: number;
  expectedProfit: number;
}

export class ArbitrageExecutor {
  private client: ClobClient | null = null;
  private config: ExecutorConfig;
  private isInitialized = false;
  private totalProfit = 0;
  private tradesExecuted = 0;

  constructor(config: ExecutorConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.config.dryRun) {
      info('Executor running in DRY RUN mode - no real trades will be placed');
      this.isInitialized = true;
      return;
    }

    if (!this.config.privateKey) {
      throw new Error('Private key is required for execution');
    }

    try {
      const host = 'https://clob.polymarket.com';
      const chainId = 137; // Polygon

      const wallet = new Wallet(this.config.privateKey);
      info(`Initializing executor with wallet: ${wallet.address}`);

      // Create client and derive API credentials
      const tempClient = new ClobClient(host, chainId, wallet);
      const creds = await tempClient.createOrDeriveApiKey();

      // Create full client with credentials
      this.client = new ClobClient(
        host,
        chainId,
        wallet,
        creds,
        this.config.signatureType,
        this.config.funderAddress || undefined
      );

      info('Executor initialized successfully');
      this.isInitialized = true;
    } catch (err) {
      error('Failed to initialize executor', err);
      throw err;
    }
  }

  async executeArbitrage(opp: ArbitrageOpportunity): Promise<TradeResult> {
    if (!this.isInitialized) {
      return { success: false, error: 'Executor not initialized', sharesTraded: 0, totalCost: 0, expectedProfit: 0 };
    }

    // Calculate position size
    const maxSharesByCapital = this.config.maxPositionSize / opp.totalCost;
    const sharesToTrade = Math.min(opp.maxShares, maxSharesByCapital);

    if (sharesToTrade < 1) {
      return { success: false, error: 'Position too small', sharesTraded: 0, totalCost: 0, expectedProfit: 0 };
    }

    const totalCost = sharesToTrade * opp.totalCost;
    const expectedProfit = sharesToTrade * opp.profit;

    info(`Executing arbitrage: ${sharesToTrade.toFixed(2)} shares, cost: $${totalCost.toFixed(2)}, profit: $${expectedProfit.toFixed(4)}`);

    if (this.config.dryRun) {
      info('[DRY RUN] Would place orders:');
      info(`  BUY ${sharesToTrade.toFixed(2)} YES @ $${opp.yesAskPrice.toFixed(4)}`);
      info(`  BUY ${sharesToTrade.toFixed(2)} NO @ $${opp.noAskPrice.toFixed(4)}`);

      this.tradesExecuted++;
      this.totalProfit += expectedProfit;

      return {
        success: true,
        sharesTraded: sharesToTrade,
        totalCost,
        expectedProfit,
        yesOrderId: 'DRY_RUN_YES',
        noOrderId: 'DRY_RUN_NO',
      };
    }

    if (!this.client) {
      return { success: false, error: 'Client not available', sharesTraded: 0, totalCost: 0, expectedProfit: 0 };
    }

    try {
      // Get market tick size
      const tickSize = '0.001'; // Default for most markets
      const negRisk = false; // Adjust based on market type

      // Place YES order
      debug(`Placing YES order: ${sharesToTrade} @ ${opp.yesAskPrice}`);
      const yesOrder = await this.client.createAndPostOrder(
        {
          tokenID: opp.market.clobTokenIds[0]!, // YES token
          price: opp.yesAskPrice,
          side: Side.BUY,
          size: sharesToTrade,
        },
        { tickSize, negRisk },
        OrderType.GTC // Fill-or-Kill for immediate execution
      );

      // Place NO order
      debug(`Placing NO order: ${sharesToTrade} @ ${opp.noAskPrice}`);
      const noOrder = await this.client.createAndPostOrder(
        {
          tokenID: opp.market.clobTokenIds[1]!, // NO token
          price: opp.noAskPrice,
          side: Side.BUY,
          size: sharesToTrade,
        },
        { tickSize, negRisk },
        OrderType.GTC
      );

      this.tradesExecuted++;
      this.totalProfit += expectedProfit;

      info(`Orders placed successfully!`);
      info(`  YES Order ID: ${yesOrder.orderID || 'pending'}`);
      info(`  NO Order ID: ${noOrder.orderID || 'pending'}`);

      return {
        success: true,
        yesOrderId: yesOrder.orderID,
        noOrderId: noOrder.orderID,
        sharesTraded: sharesToTrade,
        totalCost,
        expectedProfit,
      };
    } catch (err) {
      error('Failed to execute arbitrage', err);
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        sharesTraded: 0,
        totalCost: 0,
        expectedProfit: 0,
      };
    }
  }

  getStats(): { tradesExecuted: number; totalProfit: number } {
    return {
      tradesExecuted: this.tradesExecuted,
      totalProfit: this.totalProfit,
    };
  }

  isReady(): boolean {
    return this.isInitialized;
  }
}
