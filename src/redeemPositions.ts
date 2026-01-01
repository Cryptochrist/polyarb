import dotenv from 'dotenv';
import { ethers } from 'ethers';
import axios from 'axios';
import { fetchAllCryptoUpDownMarkets } from './gammaApi.js';

dotenv.config();

// Contract addresses on Polygon
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// CTF ABI for redemption
const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
  'function getConditionId(address oracle, bytes32 questionId, uint256 outcomeSlotCount) pure returns (bytes32)',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
];

const USDC_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

interface MarketInfo {
  conditionId: string;
  questionId: string;
  resolved: boolean;
  question: string;
  tokens: { token_id: string; outcome: string }[];
}

// Compute ERC1155 token ID from conditionId and outcome index
function computePositionId(conditionId: string, outcomeIndex: number): string {
  // For Polymarket, the position ID is computed as:
  // keccak256(abi.encodePacked(parentCollectionId, conditionId, indexSet))
  // where parentCollectionId is bytes32(0) and indexSet is 1 << outcomeIndex
  const parentCollectionId = ethers.constants.HashZero;
  const indexSet = 1 << outcomeIndex;

  const packed = ethers.utils.solidityPack(
    ['bytes32', 'bytes32', 'uint256'],
    [parentCollectionId, conditionId, indexSet]
  );

  const positionId = ethers.utils.keccak256(packed);
  return ethers.BigNumber.from(positionId).toString();
}

async function getGasPrice(provider: ethers.providers.JsonRpcProvider): Promise<ethers.BigNumber> {
  const feeData = await provider.getFeeData();
  const baseGasPrice = feeData.gasPrice || ethers.utils.parseUnits('50', 'gwei');
  return baseGasPrice.mul(110).div(100);
}

async function fetchMarketInfo(conditionId: string): Promise<MarketInfo | null> {
  try {
    const response = await axios.get(`https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`);
    if (response.data && response.data.length > 0) {
      return response.data[0];
    }
  } catch (err) {
    console.error('Failed to fetch market info:', err);
  }
  return null;
}

async function redeemPosition(conditionId: string) {
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
  console.log(`Condition ID: ${conditionId}\n`);

  const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
  const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);

  // Check if condition has been resolved (payoutDenominator > 0)
  const payoutDenominator = await ctf.payoutDenominator(conditionId);

  if (payoutDenominator.eq(0)) {
    console.log('❌ Market has not been resolved yet. Cannot redeem.');
    return;
  }

  console.log(`✅ Market resolved! Payout denominator: ${payoutDenominator.toString()}`);

  // Check payout numerators to see which outcome won
  const payout0 = await ctf.payoutNumerators(conditionId, 0);
  const payout1 = await ctf.payoutNumerators(conditionId, 1);
  console.log(`Payout for outcome 0 (YES/Up): ${payout0.toString()}`);
  console.log(`Payout for outcome 1 (NO/Down): ${payout1.toString()}`);

  // Check USDC balance before
  const usdcBefore = await usdc.balanceOf(wallet.address);
  console.log(`\nUSDC balance before: ${ethers.utils.formatUnits(usdcBefore, 6)}`);

  // Redeem positions
  // parentCollectionId is always bytes32(0) for Polymarket
  // indexSets: [1, 2] represents both binary outcomes
  const parentCollectionId = ethers.constants.HashZero;
  const indexSets = [1, 2]; // Binary market: outcome 0 and outcome 1

  console.log('\nRedeeming positions...');

  const gasPrice = await getGasPrice(provider);
  console.log(`Gas price: ${ethers.utils.formatUnits(gasPrice, 'gwei')} gwei`);

  try {
    const tx = await ctf.redeemPositions(
      USDC_ADDRESS,
      parentCollectionId,
      conditionId,
      indexSets,
      {
        gasLimit: 200000,
        gasPrice: gasPrice,
      }
    );

    console.log(`Tx sent: ${tx.hash}`);
    console.log('Waiting for confirmation...');

    const receipt = await tx.wait();
    console.log(`Confirmed in block ${receipt.blockNumber}!`);
    console.log(`Gas used: ${receipt.gasUsed.toString()}`);

    // Check USDC balance after
    const usdcAfter = await usdc.balanceOf(wallet.address);
    const redeemed = usdcAfter.sub(usdcBefore);
    console.log(`\nUSDC balance after: ${ethers.utils.formatUnits(usdcAfter, 6)}`);
    console.log(`USDC redeemed: ${ethers.utils.formatUnits(redeemed, 6)}`);

    if (redeemed.gt(0)) {
      console.log('\n✅ Successfully redeemed winning position!');
    } else {
      console.log('\n⚠️ No USDC redeemed (position may have lost or already redeemed)');
    }

  } catch (err) {
    console.error('Redemption failed:', err instanceof Error ? err.message : err);
  }
}

async function listRedeemablePositions() {
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

  console.log(`Checking positions for: ${wallet.address}\n`);

  const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);

  // Fetch all crypto up/down markets that we might have positions in
  console.log('Fetching markets to check for positions...\n');

  try {
    const markets = await fetchAllCryptoUpDownMarkets(['15m', '1h', '4h', '1d']);

    let foundPositions = 0;

    for (const market of markets) {
      const conditionId = market.conditionId;
      if (!conditionId) continue;

      // Check balances for both outcomes (YES=0, NO=1)
      for (let outcomeIndex = 0; outcomeIndex < 2; outcomeIndex++) {
        const tokenId = market.clobTokenIds[outcomeIndex];
        if (!tokenId) continue;

        try {
          const balance = await ctf.balanceOf(wallet.address, tokenId);

          if (balance.gt(0)) {
            foundPositions++;
            const outcomeName = outcomeIndex === 0 ? 'YES/Up' : 'NO/Down';
            console.log(`Market: ${market.question}`);
            console.log(`  Condition ID: ${conditionId}`);
            console.log(`  Outcome: ${outcomeName}`);
            console.log(`  Token ID: ${tokenId}`);
            console.log(`  Balance: ${ethers.utils.formatUnits(balance, 6)} shares`);

            // Check if resolved
            const payoutDenominator = await ctf.payoutDenominator(conditionId);
            const isResolved = payoutDenominator.gt(0);
            console.log(`  Resolved: ${isResolved ? '✅ YES' : '❌ NO'}`);

            if (isResolved) {
              const payout0 = await ctf.payoutNumerators(conditionId, 0);
              const payout1 = await ctf.payoutNumerators(conditionId, 1);
              const winningOutcome = payout0.gt(0) ? 'YES/Up' : 'NO/Down';
              console.log(`  Winning outcome: ${winningOutcome}`);
              console.log(`  >>> Redeem with: node dist/redeemPositions.js ${conditionId}`);
            }
            console.log('');
          }
        } catch (err) {
          // Skip errors for individual token checks
        }
      }
    }

    if (foundPositions === 0) {
      console.log('No positions found in crypto up/down markets.');
      console.log('\nNote: If you have positions in other markets, provide the conditionId directly:');
      console.log('  node dist/redeemPositions.js <conditionId>');
    } else {
      console.log(`Found ${foundPositions} position(s).`);
    }

  } catch (err) {
    console.error('Failed to fetch markets:', err instanceof Error ? err.message : err);
  }
}

// Main execution
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log('Usage:');
  console.log('  List positions:  node dist/redeemPositions.js');
  console.log('  Redeem position: node dist/redeemPositions.js <conditionId>');
  console.log('');
  listRedeemablePositions().catch(console.error);
} else {
  const conditionId = args[0];
  redeemPosition(conditionId).catch(console.error);
}
