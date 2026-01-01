import dotenv from 'dotenv';
import { ethers } from 'ethers';

dotenv.config();

const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e
const USDC_NATIVE = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; // Native USDC
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const ERC1155_ABI = [
  'function isApprovedForAll(address account, address operator) view returns (bool)',
];

const EXCHANGES = [
  { name: 'CTF Exchange', address: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' },
  { name: 'Neg Risk CTF Exchange', address: '0xC5d563A36AE78145C45a50134d48A1215220f80a' },
  { name: 'Neg Risk Adapter', address: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296' },
];

async function checkBalance() {
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

  console.log(`Wallet: ${wallet.address}\n`);

  // Check MATIC balance
  const maticBalance = await provider.getBalance(wallet.address);
  console.log(`MATIC: ${ethers.utils.formatEther(maticBalance)}`);

  // Check USDC.e balance
  const usdce = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
  const usdceBalance = await usdce.balanceOf(wallet.address);
  const usdceDecimals = await usdce.decimals();
  console.log(`USDC.e (bridged): ${ethers.utils.formatUnits(usdceBalance, usdceDecimals)}`);

  // Check native USDC balance
  const usdcNative = new ethers.Contract(USDC_NATIVE, ERC20_ABI, provider);
  const usdcNativeBalance = await usdcNative.balanceOf(wallet.address);
  const usdcNativeDecimals = await usdcNative.decimals();
  console.log(`USDC (native): ${ethers.utils.formatUnits(usdcNativeBalance, usdcNativeDecimals)}`);

  console.log('\n--- USDC.e Allowances ---');
  for (const exchange of EXCHANGES) {
    const allowance = await usdce.allowance(wallet.address, exchange.address);
    const formatted = ethers.utils.formatUnits(allowance, usdceDecimals);
    const status = allowance.gt(0) ? '✅' : '❌';
    console.log(`${status} ${exchange.name}: ${formatted}`);
  }

  console.log('\n--- CTF Approvals ---');
  const ctf = new ethers.Contract(CTF_ADDRESS, ERC1155_ABI, provider);
  for (const exchange of EXCHANGES) {
    const isApproved = await ctf.isApprovedForAll(wallet.address, exchange.address);
    const status = isApproved ? '✅' : '❌';
    console.log(`${status} ${exchange.name}: ${isApproved ? 'Approved' : 'Not Approved'}`);
  }
}

checkBalance().catch(console.error);
