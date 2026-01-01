import dotenv from 'dotenv';
import { ethers } from 'ethers';

dotenv.config();

const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const EXCHANGES = [
  { name: 'CTF Exchange', address: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' },
  { name: 'Neg Risk CTF Exchange', address: '0xC5d563A36AE78145C45a50134d48A1215220f80a' },
  { name: 'Neg Risk Adapter', address: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296' },
];

async function getGasPrice(provider: ethers.providers.JsonRpcProvider): Promise<ethers.BigNumber> {
  const feeData = await provider.getFeeData();
  const baseGasPrice = feeData.gasPrice || ethers.utils.parseUnits('50', 'gwei');
  return baseGasPrice.mul(110).div(100);
}

async function approveUsdcSafe() {
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

  console.log(`Wallet: ${wallet.address}`);

  const maticBalance = await provider.getBalance(wallet.address);
  console.log(`MATIC: ${ethers.utils.formatEther(maticBalance)}\n`);

  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);

  // Use a reasonable approval amount instead of MaxUint256
  // Some contracts don't like max approval
  const approvalAmount = ethers.utils.parseUnits('1000000', 6); // 1 million USDC

  for (const exchange of EXCHANGES) {
    console.log(`--- ${exchange.name} ---`);

    const currentAllowance = await usdc.allowance(wallet.address, exchange.address);
    console.log(`Current allowance: ${ethers.utils.formatUnits(currentAllowance, 6)}`);

    if (currentAllowance.gte(approvalAmount)) {
      console.log('Already approved!\n');
      continue;
    }

    // If there's existing non-zero allowance, reset to 0 first
    if (currentAllowance.gt(0)) {
      console.log('Resetting allowance to 0 first...');
      const gasPrice = await getGasPrice(provider);
      try {
        const resetTx = await usdc.approve(exchange.address, 0, {
          gasLimit: 60000,
          gasPrice: gasPrice,
        });
        console.log(`Reset tx: ${resetTx.hash}`);
        await resetTx.wait();
        console.log('Reset complete!');
      } catch (err) {
        console.error('Reset failed:', err instanceof Error ? err.message : err);
        continue;
      }
    }

    // Now set the approval
    console.log('Setting approval...');
    const gasPrice = await getGasPrice(provider);
    console.log(`Gas price: ${ethers.utils.formatUnits(gasPrice, 'gwei')} gwei`);

    try {
      const tx = await usdc.approve(exchange.address, approvalAmount, {
        gasLimit: 100000, // Higher gas limit
        gasPrice: gasPrice,
      });
      console.log(`Tx: ${tx.hash}`);
      console.log('Waiting for confirmation...');
      const receipt = await tx.wait();
      console.log(`Confirmed! Block: ${receipt.blockNumber}, Gas used: ${receipt.gasUsed.toString()}`);
      console.log(`Status: ${receipt.status === 1 ? '✅ Success' : '❌ Failed'}\n`);
    } catch (err) {
      console.error('Approval failed:', err instanceof Error ? err.message : err);
      console.log('');
    }
  }

  // Verify final state
  console.log('\n--- Final Allowances ---');
  for (const exchange of EXCHANGES) {
    const allowance = await usdc.allowance(wallet.address, exchange.address);
    const status = allowance.gt(0) ? '✅' : '❌';
    console.log(`${status} ${exchange.name}: ${ethers.utils.formatUnits(allowance, 6)} USDC`);
  }
}

approveUsdcSafe().catch(console.error);
