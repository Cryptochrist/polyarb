import dotenv from 'dotenv';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { fetchAllCryptoUpDownMarkets } from './gammaApi.js';
import { fetchOrderBook } from './clobApi.js';

dotenv.config();

async function testBuy15m() {
  const privateKey = process.env['PRIVATE_KEY'];
  const funderAddress = process.env['FUNDER_ADDRESS'];
  const apiKey = process.env['POLY_API_KEY'];
  const apiSecret = process.env['POLY_API_SECRET'];
  const passphrase = process.env['POLY_PASSPHRASE'];

  if (!privateKey || !funderAddress) {
    console.error('Missing PRIVATE_KEY or FUNDER_ADDRESS in .env');
    process.exit(1);
  }

  if (!apiKey || !apiSecret || !passphrase) {
    console.error('Missing POLY_API_KEY, POLY_API_SECRET, or POLY_PASSPHRASE in .env');
    process.exit(1);
  }

  console.log('Initializing wallet...');
  const wallet = new Wallet(privateKey);
  console.log(`Wallet address: ${wallet.address}`);

  const host = 'https://clob.polymarket.com';
  const chainId = 137;

  console.log('Creating CLOB client...');
  const creds = {
    key: apiKey,
    secret: apiSecret,
    passphrase: passphrase,
  };

  const client = new ClobClient(
    host,
    chainId,
    wallet,
    creds,
    0,
    funderAddress
  );

  // Fetch 15m markets only
  console.log('\nFetching 15m markets...');
  const markets = await fetchAllCryptoUpDownMarkets(['15m']);

  // Find BTC 15m market
  const btc15mMarket = markets.find(m =>
    (m.slug.includes('bitcoin-up-or-down') || m.slug.includes('btc')) &&
    m.slug.includes('15m') &&
    m.clobTokenIds.length === 2
  );

  if (!btc15mMarket) {
    console.error('Could not find BTC 15m market');
    console.log('Available markets:', markets.map(m => m.slug));
    process.exit(1);
  }

  console.log(`\nUsing market: ${btc15mMarket.question}`);
  console.log(`Slug: ${btc15mMarket.slug}`);
  console.log(`YES token: ${btc15mMarket.clobTokenIds[0]}`);
  console.log(`NO token: ${btc15mMarket.clobTokenIds[1]}`);

  // Get orderbook for YES (Up)
  const yesTokenId = btc15mMarket.clobTokenIds[0]!;
  const orderBook = await fetchOrderBook(yesTokenId);

  if (!orderBook || !orderBook.asks || orderBook.asks.length === 0) {
    console.error('No asks available in orderbook');
    process.exit(1);
  }

  // Get best ask
  const sortedAsks = [...orderBook.asks].sort(
    (a, b) => parseFloat(a.price) - parseFloat(b.price)
  );
  const bestAsk = sortedAsks[0]!;
  const price = parseFloat(bestAsk.price);

  console.log(`\nBest ask price: $${price.toFixed(4)}`);

  // Buy enough shares to meet $1 minimum
  const minOrderSize = 1.00;
  const shares = Math.ceil(minOrderSize / price);
  const totalCost = shares * price;
  console.log(`Buying ${shares} shares @ $${price.toFixed(4)} = $${totalCost.toFixed(4)}`);

  // Place order
  console.log('\n--- PLACING LIVE ORDER (BTC 15m UP) ---');

  try {
    const order = await client.createAndPostOrder(
      {
        tokenID: yesTokenId,
        price: price,
        side: Side.BUY,
        size: shares,
      },
      { tickSize: '0.01', negRisk: false },
      OrderType.GTC
    );

    console.log('\n✅ ORDER PLACED SUCCESSFULLY!');
    console.log('Order ID:', order.orderID);
    console.log('Status:', order.status);
    console.log(JSON.stringify(order, null, 2));
  } catch (err) {
    console.error('\n❌ ORDER FAILED:', err);
  }
}

testBuy15m().catch(console.error);
