import dotenv from 'dotenv';
import { ethers } from 'ethers';

dotenv.config();

// Contract addresses on Polygon
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

// Exchange contracts that need approval
const EXCHANGE_CONTRACTS = [
  '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E', // CTF Exchange
  '0xC5d563A36AE78145C45a50134d48A1215220f80a', // Neg Risk CTF Exchange
  '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296', // Neg Risk Adapter
];

// ABIs for approval functions
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const ERC1155_ABI = [
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
];

async function getGasPrice(provider: ethers.providers.JsonRpcProvider): Promise<ethers.BigNumber> {
  const feeData = await provider.getFeeData();
  const baseGasPrice = feeData.gasPrice || ethers.utils.parseUnits('50', 'gwei');
  return baseGasPrice.mul(110).div(100); // +10%
}

async function setAllowances() {
  const privateKey = process.env['PRIVATE_KEY'];

  if (!privateKey) {
    console.error('Missing PRIVATE_KEY in .env');
    process.exit(1);
  }

  console.log('Setting up Polymarket trading allowances...\n');

  // Connect to Polygon - explicitly set network
  const provider = new ethers.providers.JsonRpcProvider(
    'https://polygon-rpc.com',
    { name: 'matic', chainId: 137 }
  );
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log(`Wallet address: ${wallet.address}`);

  // Check MATIC balance for gas
  const balance = await provider.getBalance(wallet.address);
  console.log(`MATIC balance: ${ethers.utils.formatEther(balance)} MATIC`);

  if (balance.lt(ethers.utils.parseEther('0.1'))) {
    console.warn('\nWARNING: Low MATIC balance. You need MATIC/POL for gas fees.');
    console.warn('Get some from: https://wallet.polygon.technology/bridge');
  }

  // Create contract instances
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
  const ctf = new ethers.Contract(CTF_ADDRESS, ERC1155_ABI, wallet);

  const maxApproval = ethers.constants.MaxUint256;

  console.log('\n--- Setting Allowances ---\n');

  for (const exchangeAddress of EXCHANGE_CONTRACTS) {
    console.log(`Exchange: ${exchangeAddress}`);

    // Check current USDC allowance
    const currentAllowance = await usdc.allowance(wallet.address, exchangeAddress);
    if (currentAllowance.gt(0)) {
      console.log('  USDC: Already approved');
    } else {
      console.log('  USDC: Approving...');
      try {
        const gasPrice = await getGasPrice(provider);
        console.log(`  Gas price: ${ethers.utils.formatUnits(gasPrice, 'gwei')} gwei`);
        const tx = await usdc.approve(exchangeAddress, maxApproval, {
          gasLimit: 60000,
          gasPrice: gasPrice,
        });
        console.log(`  USDC: Tx sent: ${tx.hash}`);
        await tx.wait();
        console.log('  USDC: Approved!');
      } catch (err) {
        console.error('  USDC: Failed -', err instanceof Error ? err.message : err);
      }
    }

    // Check current CTF approval
    const isApproved = await ctf.isApprovedForAll(wallet.address, exchangeAddress);
    if (isApproved) {
      console.log('  CTF: Already approved');
    } else {
      console.log('  CTF: Approving...');
      try {
        const gasPrice = await getGasPrice(provider);
        const tx = await ctf.setApprovalForAll(exchangeAddress, true, {
          gasLimit: 60000,
          gasPrice: gasPrice,
        });
        console.log(`  CTF: Tx sent: ${tx.hash}`);
        await tx.wait();
        console.log('  CTF: Approved!');
      } catch (err) {
        console.error('  CTF: Failed -', err instanceof Error ? err.message : err);
      }
    }

    console.log('');
  }

  console.log('--- Allowance Setup Complete ---');
  console.log('\nYou can now place orders on Polymarket!');
}

setAllowances().catch(console.error);
