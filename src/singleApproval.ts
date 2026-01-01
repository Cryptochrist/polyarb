import dotenv from 'dotenv';
import { ethers } from 'ethers';
import axios from 'axios';

dotenv.config();

const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const EXCHANGE_3 = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

const ERC1155_ABI = [
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
];

async function getGasPrice(provider: ethers.providers.JsonRpcProvider): Promise<ethers.BigNumber> {
  // Get gas price from RPC (most accurate)
  const feeData = await provider.getFeeData();
  const baseGasPrice = feeData.gasPrice || ethers.utils.parseUnits('100', 'gwei');

  // Add 10% buffer
  const gasPrice = baseGasPrice.mul(110).div(100);

  console.log(`RPC base gas: ${ethers.utils.formatUnits(baseGasPrice, 'gwei')} gwei`);
  console.log(`Using (+10%): ${ethers.utils.formatUnits(gasPrice, 'gwei')} gwei`);

  return gasPrice;
}

async function singleApproval() {
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

  const balance = await provider.getBalance(wallet.address);
  console.log(`MATIC balance: ${ethers.utils.formatEther(balance)} MATIC`);

  const ctf = new ethers.Contract(CTF_ADDRESS, ERC1155_ABI, wallet);

  // Check if already approved
  const isApproved = await ctf.isApprovedForAll(wallet.address, EXCHANGE_3);
  if (isApproved) {
    console.log('CTF already approved for Exchange 3!');
    return;
  }

  console.log(`\nApproving CTF for Exchange 3: ${EXCHANGE_3}`);

  // Get gas price from RPC + 10%
  const gasPrice = await getGasPrice(provider);
  console.log(`Estimated cost: ${ethers.utils.formatEther(gasPrice.mul(50000))} MATIC`);

  const tx = await ctf.setApprovalForAll(EXCHANGE_3, true, {
    gasLimit: 50000,
    gasPrice: gasPrice,
  });

  console.log(`Tx sent: ${tx.hash}`);
  console.log('Waiting for confirmation...');

  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}!`);
  console.log(`Gas used: ${receipt.gasUsed.toString()}`);
  console.log(`https://polygonscan.com/tx/${tx.hash}`);
}

singleApproval().catch(console.error);
