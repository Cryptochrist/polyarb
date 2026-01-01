import dotenv from 'dotenv';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { fetchAllCryptoUpDownMarkets } from './gammaApi.js';
import { fetchOrderBook } from './clobApi.js';

dotenv.config();

async function testBuy() {
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
  const chainId = 137; // Polygon

  console.log('Creating CLOB client with API credentials...');
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
    0, // EOA signature type
    funderAddress
  );
  console.log('Client initialized with API key:', apiKey.slice(0, 12) + '...');

  // Get a market to test with
  console.log('\nFetching markets...');
  const markets = await fetchAllCryptoUpDownMarkets(['15m', '1h', '4h', '1d']);

  // Find a market with good liquidity - use 1h BTC
  const btcMarket = markets.find(m =>
    m.slug.includes('bitcoin-up-or-down') &&
    !m.slug.includes('15m') &&
    m.clobTokenIds.length === 2
  );

  if (!btcMarket) {
    console.error('Could not find suitable BTC market');
    process.exit(1);
  }

  console.log(`\nUsing market: ${btcMarket.question}`);
  console.log(`YES token: ${btcMarket.clobTokenIds[0]}`);
  console.log(`NO token: ${btcMarket.clobTokenIds[1]}`);

  // Fetch orderbook to get current prices
  const yesTokenId = btcMarket.clobTokenIds[0]!;
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

  // Calculate shares needed to meet $1 minimum order size
  const minOrderSize = 1.00;
  const shares = Math.ceil(minOrderSize / price);
  const totalCost = shares * price;
  console.log(`Buying ${shares} shares @ $${price.toFixed(4)} = $${totalCost.toFixed(4)} (min order: $${minOrderSize})`);

  // Place order
  console.log('\n--- PLACING LIVE ORDER ---');

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

testBuy().catch(console.error);
