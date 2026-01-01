import dotenv from 'dotenv';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';

dotenv.config();

async function deriveApiCreds() {
  const privateKey = process.env['PRIVATE_KEY'];

  if (!privateKey) {
    console.error('Missing PRIVATE_KEY in .env');
    process.exit(1);
  }

  console.log('Deriving API credentials from private key...\n');

  const wallet = new Wallet(privateKey);
  console.log(`Wallet address: ${wallet.address}`);

  const host = 'https://clob.polymarket.com';
  const chainId = 137;

  // Create client without credentials first
  const client = new ClobClient(host, chainId, wallet);

  try {
    // Derive or create API credentials
    console.log('\nDeriving API credentials...');
    const creds = await client.createOrDeriveApiKey();

    console.log('\n=== NEW API CREDENTIALS ===');
    console.log(`POLY_API_KEY=${creds.key}`);
    console.log(`POLY_API_SECRET=${creds.secret}`);
    console.log(`POLY_PASSPHRASE=${creds.passphrase}`);
    console.log('===========================\n');

    console.log('Update these values in your .env file!');

  } catch (err) {
    console.error('Failed to derive credentials:', err);
  }
}

deriveApiCreds().catch(console.error);
