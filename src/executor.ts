import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import type { ArbitrageOpportunity } from './types.js';
import type { CrossMarketOpportunity } from './crossMarketDetector.js';
import { info, warn, error, debug } from './logger.js';
import { notifyExecutionAttempt, notifyExecutionSuccess, notifyExecutionFailure } from './telegram.js';

export interface ExecutorConfig {
  privateKey: string;
  funderAddress: string;      // Your Polymarket profile address
  signatureType: 0 | 1 | 2;   // 0=EOA, 1=Magic/Email, 2=Browser/Gnosis
  maxPositionSize: number;    // Max USD per trade
  dryRun: boolean;            // If true, log but don't execute
  // API credentials (if provided, skip derivation)
  apiKey?: string;
  apiSecret?: string;
  passphrase?: string;
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

interface CrossMarketTradeResult {
  success: boolean;
  longOrderId?: string;
  shortOrderId?: string;
  error?: string;
  sharesTraded: number;
  totalCost: number;
  maxProfit: number;
}

// Polymarket order constraints
const MIN_ORDER_AMOUNT_USD = 1.00;  // Minimum $1 per order
const MIN_SHARES = 5;               // Minimum 5 shares per order
const MIN_PRICE = 0.01;             // Minimum price $0.01
const MAX_PRICE = 0.99;             // Maximum price $0.99

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

      // Use provided API credentials or derive new ones
      let creds;
      if (this.config.apiKey && this.config.apiSecret && this.config.passphrase) {
        info('Using provided API credentials from environment');
        creds = {
          key: this.config.apiKey,
          secret: this.config.apiSecret,
          passphrase: this.config.passphrase,
        };
      } else {
        info('Deriving API credentials (this may take a moment)...');
        const tempClient = new ClobClient(host, chainId, wallet);
        creds = await tempClient.createOrDeriveApiKey();
      }

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

    // Validate price constraints (0.01 - 0.99)
    if (opp.yesAskPrice < MIN_PRICE || opp.yesAskPrice > MAX_PRICE) {
      return { success: false, error: `YES price ${opp.yesAskPrice.toFixed(4)} outside valid range (${MIN_PRICE}-${MAX_PRICE})`, sharesTraded: 0, totalCost: 0, expectedProfit: 0 };
    }
    if (opp.noAskPrice < MIN_PRICE || opp.noAskPrice > MAX_PRICE) {
      return { success: false, error: `NO price ${opp.noAskPrice.toFixed(4)} outside valid range (${MIN_PRICE}-${MAX_PRICE})`, sharesTraded: 0, totalCost: 0, expectedProfit: 0 };
    }

    // Calculate minimum shares needed to meet $1 minimum per order
    const minSharesForYesOrder = Math.ceil(MIN_ORDER_AMOUNT_USD / opp.yesAskPrice);
    const minSharesForNoOrder = Math.ceil(MIN_ORDER_AMOUNT_USD / opp.noAskPrice);
    const minSharesForDollarAmount = Math.max(minSharesForYesOrder, minSharesForNoOrder);

    // Must meet BOTH the 5-share minimum AND the $1 minimum per order
    const effectiveMinShares = Math.max(MIN_SHARES, minSharesForDollarAmount);

    // Calculate position size
    const maxSharesByCapital = this.config.maxPositionSize / opp.totalCost;
    let sharesToTrade = Math.min(opp.maxShares, maxSharesByCapital);

    // Enforce minimum share constraint
    if (sharesToTrade < effectiveMinShares) {
      // Check if we can afford the minimum
      const minCost = effectiveMinShares * opp.totalCost;
      if (minCost <= this.config.maxPositionSize && opp.maxShares >= effectiveMinShares) {
        sharesToTrade = effectiveMinShares;
        warn(`Increasing shares to ${effectiveMinShares} to meet Polymarket minimums (5 shares, $1/order)`);
      } else {
        return {
          success: false,
          error: `Need ${effectiveMinShares} shares (min 5, or $1/order), but only ${sharesToTrade.toFixed(2)} available/affordable`,
          sharesTraded: 0,
          totalCost: 0,
          expectedProfit: 0
        };
      }
    }

    const totalCost = sharesToTrade * opp.totalCost;
    const expectedProfit = sharesToTrade * opp.profit;

    // Final validation: ensure each order meets $1 minimum
    const yesOrderAmount = sharesToTrade * opp.yesAskPrice;
    const noOrderAmount = sharesToTrade * opp.noAskPrice;

    if (yesOrderAmount < MIN_ORDER_AMOUNT_USD) {
      return { success: false, error: `YES order $${yesOrderAmount.toFixed(2)} < $1 minimum`, sharesTraded: 0, totalCost: 0, expectedProfit: 0 };
    }
    if (noOrderAmount < MIN_ORDER_AMOUNT_USD) {
      return { success: false, error: `NO order $${noOrderAmount.toFixed(2)} < $1 minimum`, sharesTraded: 0, totalCost: 0, expectedProfit: 0 };
    }

    info(`Executing arbitrage: ${sharesToTrade.toFixed(2)} shares, cost: $${totalCost.toFixed(2)}, profit: $${expectedProfit.toFixed(4)}`);
    info(`  Order amounts: YES $${yesOrderAmount.toFixed(2)} (${opp.yesAskPrice.toFixed(2)}), NO $${noOrderAmount.toFixed(2)} (${opp.noAskPrice.toFixed(2)})`);

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
      // Get market tick size (0.01 for most up/down markets, 0.001 for others)
      const tickSize = '0.01';
      const negRisk = false;

      // Place YES and NO orders in PARALLEL for same-block execution
      debug(`Placing parallel orders: ${sharesToTrade} YES @ ${opp.yesAskPrice}, NO @ ${opp.noAskPrice}`);

      const [yesOrder, noOrder] = await Promise.all([
        this.client.createAndPostOrder(
          {
            tokenID: opp.market.clobTokenIds[0]!, // YES token
            price: opp.yesAskPrice,
            side: Side.BUY,
            size: sharesToTrade,
          },
          { tickSize, negRisk },
          OrderType.GTC
        ),
        this.client.createAndPostOrder(
          {
            tokenID: opp.market.clobTokenIds[1]!, // NO token
            price: opp.noAskPrice,
            side: Side.BUY,
            size: sharesToTrade,
          },
          { tickSize, negRisk },
          OrderType.GTC
        ),
      ]);

      this.tradesExecuted++;
      this.totalProfit += expectedProfit;

      info(`Orders placed successfully (parallel execution)!`);
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

  async executeCrossMarket(opp: CrossMarketOpportunity): Promise<CrossMarketTradeResult> {
    // Extract asset and strategy early for error notifications
    const asset = opp.longMarket.slug.split('-')[0]?.toUpperCase() || 'UNKNOWN';
    const strategyDesc = opp.strategy === 'LONG_DOWN_SHORT_UP'
      ? `${opp.longInterval} DOWN + ${opp.shortInterval} UP`
      : `${opp.longInterval} UP + ${opp.shortInterval} DOWN`;

    if (!this.isInitialized) {
      return { success: false, error: 'Executor not initialized', sharesTraded: 0, totalCost: 0, maxProfit: 0 };
    }

    // Only execute if entry cost <= $1.00 (profitable zone bet)
    if (opp.entryCost > 1.00) {
      return { success: false, error: `Entry cost ${opp.entryCost.toFixed(4)} > $1.00`, sharesTraded: 0, totalCost: 0, maxProfit: 0 };
    }

    // Determine prices first so we can validate constraints
    let longPrice: number;
    let shortPrice: number;

    if (opp.strategy === 'LONG_DOWN_SHORT_UP') {
      longPrice = opp.longDownAsk;
      shortPrice = opp.shortUpAsk;
    } else {
      longPrice = opp.longUpAsk;
      shortPrice = opp.shortDownAsk;
    }

    // Validate price constraints (0.01 - 0.99)
    if (longPrice < MIN_PRICE || longPrice > MAX_PRICE) {
      const errMsg = `Long price ${longPrice.toFixed(4)} outside valid range (${MIN_PRICE}-${MAX_PRICE})`;
      notifyExecutionFailure('cross', asset, strategyDesc, errMsg, opp.maxShares, opp.entryCost)
        .catch(e => error('Telegram notification failed', e));
      return { success: false, error: errMsg, sharesTraded: 0, totalCost: 0, maxProfit: 0 };
    }
    if (shortPrice < MIN_PRICE || shortPrice > MAX_PRICE) {
      const errMsg = `Short price ${shortPrice.toFixed(4)} outside valid range (${MIN_PRICE}-${MAX_PRICE})`;
      notifyExecutionFailure('cross', asset, strategyDesc, errMsg, opp.maxShares, opp.entryCost)
        .catch(e => error('Telegram notification failed', e));
      return { success: false, error: errMsg, sharesTraded: 0, totalCost: 0, maxProfit: 0 };
    }

    // Calculate minimum shares needed to meet $1 minimum per order
    const minSharesForLongOrder = Math.ceil(MIN_ORDER_AMOUNT_USD / longPrice);
    const minSharesForShortOrder = Math.ceil(MIN_ORDER_AMOUNT_USD / shortPrice);
    const minSharesForDollarAmount = Math.max(minSharesForLongOrder, minSharesForShortOrder);

    // Must meet BOTH the 5-share minimum AND the $1 minimum per order
    const effectiveMinShares = Math.max(MIN_SHARES, minSharesForDollarAmount);

    // Calculate position size based on max position and available liquidity
    const maxSharesByCapital = this.config.maxPositionSize / opp.entryCost;
    let sharesToTrade = Math.min(opp.maxShares, maxSharesByCapital);

    // Enforce minimum share constraint
    if (sharesToTrade < effectiveMinShares) {
      // Check if we can afford the minimum
      const minCost = effectiveMinShares * opp.entryCost;
      if (minCost <= this.config.maxPositionSize && opp.maxShares >= effectiveMinShares) {
        sharesToTrade = effectiveMinShares;
        warn(`Increasing shares to ${effectiveMinShares} to meet Polymarket minimums (5 shares, $1/order)`);
      } else {
        const errMsg = `Need ${effectiveMinShares} shares (min 5, or $1/order), but only ${sharesToTrade.toFixed(2)} available/affordable`;
        notifyExecutionFailure('cross', asset, strategyDesc, errMsg, opp.maxShares, opp.entryCost)
          .catch(e => error('Telegram notification failed', e));
        return {
          success: false,
          error: errMsg,
          sharesTraded: 0,
          totalCost: 0,
          maxProfit: 0
        };
      }
    }

    const totalCost = sharesToTrade * opp.entryCost;
    const maxProfit = sharesToTrade * opp.maxProfit;

    // Final validation: ensure each order meets $1 minimum
    const longOrderAmount = sharesToTrade * longPrice;
    const shortOrderAmount = sharesToTrade * shortPrice;

    if (longOrderAmount < MIN_ORDER_AMOUNT_USD) {
      const errMsg = `Long order $${longOrderAmount.toFixed(2)} < $1 minimum`;
      notifyExecutionFailure('cross', asset, strategyDesc, errMsg, sharesToTrade, opp.entryCost)
        .catch(e => error('Telegram notification failed', e));
      return { success: false, error: errMsg, sharesTraded: 0, totalCost: 0, maxProfit: 0 };
    }
    if (shortOrderAmount < MIN_ORDER_AMOUNT_USD) {
      const errMsg = `Short order $${shortOrderAmount.toFixed(2)} < $1 minimum`;
      notifyExecutionFailure('cross', asset, strategyDesc, errMsg, sharesToTrade, opp.entryCost)
        .catch(e => error('Telegram notification failed', e));
      return { success: false, error: errMsg, sharesTraded: 0, totalCost: 0, maxProfit: 0 };
    }

    // Determine which tokens to buy based on strategy
    let longTokenId: string;
    let shortTokenId: string;

    if (opp.strategy === 'LONG_DOWN_SHORT_UP') {
      // Buy long-interval DOWN + short-interval UP
      longTokenId = opp.longDownTokenId;
      shortTokenId = opp.shortUpTokenId;
    } else {
      // Buy long-interval UP + short-interval DOWN
      longTokenId = opp.longUpTokenId;
      shortTokenId = opp.shortDownTokenId;
    }

    info(`Executing cross-market zone bet: ${sharesToTrade.toFixed(2)} shares, cost: $${totalCost.toFixed(2)}, max profit: $${maxProfit.toFixed(4)}`);
    info(`  Strategy: ${strategyDesc}`);
    info(`  Zone: $${opp.profitZoneLow.toLocaleString()} - $${opp.profitZoneHigh.toLocaleString()} (${opp.profitZonePercent.toFixed(3)}%)`);
    info(`  Order amounts: Long $${longOrderAmount.toFixed(2)} (${longPrice.toFixed(2)}), Short $${shortOrderAmount.toFixed(2)} (${shortPrice.toFixed(2)})`);

    // Send Telegram notification for execution attempt
    notifyExecutionAttempt(
      'cross',
      asset,
      strategyDesc,
      sharesToTrade,
      opp.entryCost,
      longOrderAmount,
      shortOrderAmount,
      longPrice,
      shortPrice
    ).catch(err => error('Telegram notification failed', err));

    if (this.config.dryRun) {
      info('[DRY RUN] Would place orders:');
      info(`  BUY ${sharesToTrade.toFixed(2)} ${opp.strategy === 'LONG_DOWN_SHORT_UP' ? 'DOWN' : 'UP'} @ $${longPrice.toFixed(4)} (${opp.longInterval})`);
      info(`  BUY ${sharesToTrade.toFixed(2)} ${opp.strategy === 'LONG_DOWN_SHORT_UP' ? 'UP' : 'DOWN'} @ $${shortPrice.toFixed(4)} (${opp.shortInterval})`);

      this.tradesExecuted++;
      this.totalProfit += maxProfit;

      return {
        success: true,
        sharesTraded: sharesToTrade,
        totalCost,
        maxProfit,
        longOrderId: 'DRY_RUN_LONG',
        shortOrderId: 'DRY_RUN_SHORT',
      };
    }

    if (!this.client) {
      return { success: false, error: 'Client not available', sharesTraded: 0, totalCost: 0, maxProfit: 0 };
    }

    try {
      const tickSize = '0.01';
      const negRisk = false;

      // Place both orders in PARALLEL for same-block execution
      debug(`Placing parallel cross-market orders: ${sharesToTrade} shares each`);

      const [longOrder, shortOrder] = await Promise.all([
        this.client.createAndPostOrder(
          {
            tokenID: longTokenId,
            price: longPrice,
            side: Side.BUY,
            size: sharesToTrade,
          },
          { tickSize, negRisk },
          OrderType.GTC
        ),
        this.client.createAndPostOrder(
          {
            tokenID: shortTokenId,
            price: shortPrice,
            side: Side.BUY,
            size: sharesToTrade,
          },
          { tickSize, negRisk },
          OrderType.GTC
        ),
      ]);

      this.tradesExecuted++;
      this.totalProfit += maxProfit;

      info(`Cross-market orders placed successfully (parallel execution)!`);
      info(`  Long Order ID: ${longOrder.orderID || 'pending'}`);
      info(`  Short Order ID: ${shortOrder.orderID || 'pending'}`);

      // Send Telegram success notification
      notifyExecutionSuccess(
        'cross',
        asset,
        strategyDesc,
        sharesToTrade,
        totalCost,
        maxProfit,
        longOrder.orderID,
        shortOrder.orderID
      ).catch(err => error('Telegram notification failed', err));

      return {
        success: true,
        longOrderId: longOrder.orderID,
        shortOrderId: shortOrder.orderID,
        sharesTraded: sharesToTrade,
        totalCost,
        maxProfit,
      };
    } catch (err) {
      error('Failed to execute cross-market trade', err);

      // Send Telegram failure notification
      const errMsg = err instanceof Error ? err.message : String(err);
      notifyExecutionFailure(
        'cross',
        asset,
        strategyDesc,
        errMsg,
        sharesToTrade,
        opp.entryCost
      ).catch(e => error('Telegram notification failed', e));

      return {
        success: false,
        error: errMsg,
        sharesTraded: 0,
        totalCost: 0,
        maxProfit: 0,
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
