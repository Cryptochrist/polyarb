import dotenv from 'dotenv';
import { ethers } from 'ethers';

dotenv.config();

async function cancelStuckTx() {
  const privateKey = process.env['PRIVATE_KEY'];

  if (!privateKey) {
    console.error('Missing PRIVATE_KEY in .env');
    process.exit(1);
  }

  const provider = new ethers.providers.JsonRpcProvider(
    'https://polygon-rpc.com',
    { name: 'matic', chainId: 137 }
  );
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log(`Wallet: ${wallet.address}`);

  // Get current nonce (pending)
  const pendingNonce = await provider.getTransactionCount(wallet.address, 'pending');
  const confirmedNonce = await provider.getTransactionCount(wallet.address, 'latest');

  console.log(`Confirmed nonce: ${confirmedNonce}`);
  console.log(`Pending nonce: ${pendingNonce}`);

  if (pendingNonce === confirmedNonce) {
    console.log('No stuck transactions!');
    return;
  }

  console.log(`\nFound ${pendingNonce - confirmedNonce} stuck transaction(s)`);
  console.log('Sending replacement transaction to cancel stuck tx...\n');

  // Send a 0-value tx to self with the stuck nonce and very high gas
  for (let nonce = confirmedNonce; nonce < pendingNonce; nonce++) {
    console.log(`Replacing nonce ${nonce}...`);
    try {
      // Get current gas price and add 50% to replace stuck tx
      const feeData = await provider.getFeeData();
      const baseGas = feeData.gasPrice || ethers.utils.parseUnits('100', 'gwei');
      const gasPrice = baseGas.mul(150).div(100); // +50%

      console.log(`  Gas price: ${ethers.utils.formatUnits(gasPrice, 'gwei')} gwei`);

      const tx = await wallet.sendTransaction({
        to: wallet.address,
        value: 0,
        nonce: nonce,
        gasLimit: 21000,
        gasPrice: gasPrice,
      });
      console.log(`Tx sent: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`Confirmed in block ${receipt.blockNumber}!`);
    } catch (err) {
      console.error(`Failed:`, err instanceof Error ? err.message : err);
    }
  }

  console.log('\nDone! You can now run the allowances script again.');
}

cancelStuckTx().catch(console.error);
