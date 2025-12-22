import type { RiskConfig, ArbitrageOpportunity } from './types.js';
import { info, warn, error } from './logger.js';

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxPositionPerMarket: 200,    // $200 max per market
  maxGlobalExposure: 5000,      // $5000 total exposure
  maxDailyLoss: 500,            // Stop if down $500 in a day
  enableKillSwitch: false,
};

interface Position {
  marketId: string;
  side: 'YES' | 'NO' | 'BOTH';
  shares: number;
  entryPrice: number;
  timestamp: Date;
}

interface DailyStats {
  date: string;
  trades: number;
  profit: number;
  loss: number;
}

export class RiskManager {
  private config: RiskConfig;
  private positions: Map<string, Position> = new Map();
  private dailyStats: DailyStats;
  private totalExposure = 0;
  private killSwitchActive = false;

  constructor(config: Partial<RiskConfig> = {}) {
    this.config = { ...DEFAULT_RISK_CONFIG, ...config };
    this.dailyStats = this.createDailyStats();
  }

  private createDailyStats(): DailyStats {
    return {
      date: new Date().toISOString().split('T')[0]!,
      trades: 0,
      profit: 0,
      loss: 0,
    };
  }

  private checkDayRollover(): void {
    const today = new Date().toISOString().split('T')[0]!;
    if (this.dailyStats.date !== today) {
      info(`New trading day: ${today}`);
      this.dailyStats = this.createDailyStats();
    }
  }

  canTrade(opp: ArbitrageOpportunity, requestedShares: number): { allowed: boolean; reason?: string; maxShares?: number } {
    this.checkDayRollover();

    // Check kill switch
    if (this.killSwitchActive || this.config.enableKillSwitch) {
      return { allowed: false, reason: 'Kill switch is active' };
    }

    // Check daily loss limit
    const netDaily = this.dailyStats.profit - this.dailyStats.loss;
    if (netDaily < -this.config.maxDailyLoss) {
      this.activateKillSwitch('Daily loss limit exceeded');
      return { allowed: false, reason: `Daily loss limit exceeded (${netDaily.toFixed(2)})` };
    }

    // Check global exposure
    const tradeValue = requestedShares * opp.totalCost;
    if (this.totalExposure + tradeValue > this.config.maxGlobalExposure) {
      const availableExposure = this.config.maxGlobalExposure - this.totalExposure;
      const maxSharesByExposure = Math.floor(availableExposure / opp.totalCost);

      if (maxSharesByExposure < 1) {
        return { allowed: false, reason: 'Global exposure limit reached' };
      }

      return {
        allowed: true,
        maxShares: maxSharesByExposure,
        reason: `Reduced to ${maxSharesByExposure} shares due to exposure limit`,
      };
    }

    // Check per-market limit
    const existingPosition = this.positions.get(opp.market.id);
    const existingExposure = existingPosition ? existingPosition.shares * existingPosition.entryPrice : 0;
    const newExposure = existingExposure + tradeValue;

    if (newExposure > this.config.maxPositionPerMarket) {
      const availableForMarket = this.config.maxPositionPerMarket - existingExposure;
      const maxSharesByMarket = Math.floor(availableForMarket / opp.totalCost);

      if (maxSharesByMarket < 1) {
        return { allowed: false, reason: `Market position limit reached (${opp.market.id})` };
      }

      return {
        allowed: true,
        maxShares: maxSharesByMarket,
        reason: `Reduced to ${maxSharesByMarket} shares due to per-market limit`,
      };
    }

    return { allowed: true, maxShares: requestedShares };
  }

  recordTrade(
    marketId: string,
    shares: number,
    entryPrice: number,
    profit: number
  ): void {
    this.checkDayRollover();

    // Update position
    const existing = this.positions.get(marketId);
    if (existing) {
      existing.shares += shares;
      // Average entry price
      existing.entryPrice = (existing.entryPrice + entryPrice) / 2;
    } else {
      this.positions.set(marketId, {
        marketId,
        side: 'BOTH',
        shares,
        entryPrice,
        timestamp: new Date(),
      });
    }

    // Update exposure
    this.totalExposure += shares * entryPrice;

    // Update daily stats
    this.dailyStats.trades++;
    if (profit >= 0) {
      this.dailyStats.profit += profit;
    } else {
      this.dailyStats.loss += Math.abs(profit);
    }

    info(`Trade recorded: ${shares} shares @ $${entryPrice.toFixed(4)}, P/L: $${profit.toFixed(4)}`);
  }

  activateKillSwitch(reason: string): void {
    this.killSwitchActive = true;
    error(`KILL SWITCH ACTIVATED: ${reason}`);
    warn('All trading has been halted. Manual intervention required.');
  }

  deactivateKillSwitch(): void {
    this.killSwitchActive = false;
    info('Kill switch deactivated - trading resumed');
  }

  getStats(): {
    totalExposure: number;
    positionCount: number;
    dailyTrades: number;
    dailyPnL: number;
    killSwitchActive: boolean;
  } {
    return {
      totalExposure: this.totalExposure,
      positionCount: this.positions.size,
      dailyTrades: this.dailyStats.trades,
      dailyPnL: this.dailyStats.profit - this.dailyStats.loss,
      killSwitchActive: this.killSwitchActive,
    };
  }

  isKillSwitchActive(): boolean {
    return this.killSwitchActive;
  }
}
