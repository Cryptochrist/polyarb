import dotenv from 'dotenv';
import { ethers } from 'ethers';

dotenv.config();

const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// Extended ABI to check blacklist status
const USDC_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function isBlacklisted(address _account) view returns (bool)',
  'function paused() view returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const EXCHANGES = [
  { name: 'CTF Exchange', address: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' },
  { name: 'Neg Risk CTF Exchange', address: '0xC5d563A36AE78145C45a50134d48A1215220f80a' },
  { name: 'Neg Risk Adapter', address: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296' },
];

async function checkUsdcStatus() {
  const privateKey = process.env['PRIVATE_KEY'];
  if (!privateKey) {
    console.error('Missing PRIVATE_KEY');
    process.exit(1);
  }

  const provider = new ethers.providers.JsonRpcProvider(
    'https://polygon-rpc.com',
    { name: 'matic', chainId: 137 }
  );
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log(`Checking USDC.e status for wallet: ${wallet.address}\n`);

  const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);

  // Check balance
  const balance = await usdc.balanceOf(wallet.address);
  const decimals = await usdc.decimals();
  console.log(`USDC.e Balance: ${ethers.utils.formatUnits(balance, decimals)}`);

  // Check if paused
  try {
    const paused = await usdc.paused();
    console.log(`Contract Paused: ${paused}`);
  } catch (e) {
    console.log('Could not check pause status');
  }

  // Check if wallet is blacklisted
  try {
    const isBlacklisted = await usdc.isBlacklisted(wallet.address);
    console.log(`Wallet Blacklisted: ${isBlacklisted}`);
  } catch (e) {
    console.log('Could not check blacklist status (function may not exist)');
  }

  // Check if exchange contracts are blacklisted
  console.log('\n--- Exchange Blacklist Status ---');
  for (const exchange of EXCHANGES) {
    try {
      const isBlacklisted = await usdc.isBlacklisted(exchange.address);
      console.log(`${exchange.name}: ${isBlacklisted ? '❌ BLACKLISTED' : '✅ Not blacklisted'}`);
    } catch (e) {
      console.log(`${exchange.name}: Could not check`);
    }
  }

  // Check current allowances
  console.log('\n--- Current Allowances ---');
  for (const exchange of EXCHANGES) {
    const allowance = await usdc.allowance(wallet.address, exchange.address);
    console.log(`${exchange.name}: ${ethers.utils.formatUnits(allowance, decimals)}`);
  }
}

checkUsdcStatus().catch(console.error);
