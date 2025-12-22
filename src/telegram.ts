import axios from 'axios';
import type { ArbitrageOpportunity } from './types.js';
import type { ExtendedOpportunity } from './arbDetector.js';
import { info, error, warn } from './logger.js';

interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
}

let config: TelegramConfig | null = null;

export function initTelegram(botToken?: string, chatId?: string): boolean {
  if (!botToken || !chatId) {
    warn('Telegram notifications disabled - TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
    return false;
  }

  config = {
    botToken,
    chatId,
    enabled: true,
  };

  info('Telegram notifications enabled');
  return true;
}

export async function sendTelegramMessage(message: string): Promise<boolean> {
  if (!config?.enabled) return false;

  try {
    await axios.post(
      `https://api.telegram.org/bot${config.botToken}/sendMessage`,
      {
        chat_id: config.chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      },
      { timeout: 10000 }
    );
    return true;
  } catch (err) {
    error('Failed to send Telegram message', err);
    return false;
  }
}

export async function notifyOpportunity(opp: ExtendedOpportunity | ArbitrageOpportunity): Promise<void> {
  if (!config?.enabled) return;

  const type = 'type' in opp ? opp.type : 'BUY_BOTH';
  const maxProfit = opp.profit * opp.maxShares;

  const message = `
🚨 <b>ARBITRAGE OPPORTUNITY</b>

<b>Type:</b> ${type}
<b>Market:</b> ${opp.market.question.slice(0, 100)}${opp.market.question.length > 100 ? '...' : ''}

<b>YES Ask:</b> $${opp.yesAskPrice.toFixed(4)}
<b>NO Ask:</b> $${opp.noAskPrice.toFixed(4)}
<b>Total Cost:</b> $${opp.totalCost.toFixed(4)}

<b>Profit/Share:</b> $${opp.profit.toFixed(4)} (${(opp.profitPercent * 100).toFixed(2)}%)
<b>Max Shares:</b> ${opp.maxShares.toFixed(2)}
<b>Max Profit:</b> $${maxProfit.toFixed(2)}

<b>Liquidity:</b> $${opp.market.liquidityNum.toLocaleString()}
<b>Time:</b> ${new Date().toISOString()}
`.trim();

  await sendTelegramMessage(message);
}

export async function notifyStartup(marketsCount: number, mode: string): Promise<void> {
  if (!config?.enabled) return;

  const message = `
✅ <b>PolyArb Scanner Started</b>

<b>Mode:</b> ${mode}
<b>Markets:</b> ${marketsCount}
<b>Time:</b> ${new Date().toISOString()}
`.trim();

  await sendTelegramMessage(message);
}

export async function notifyError(errorMsg: string): Promise<void> {
  if (!config?.enabled) return;

  const message = `
⚠️ <b>PolyArb Error</b>

${errorMsg}

<b>Time:</b> ${new Date().toISOString()}
`.trim();

  await sendTelegramMessage(message);
}

export function isTelegramEnabled(): boolean {
  return config?.enabled ?? false;
}
