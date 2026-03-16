import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import keyPairJson from "../keypair.json" with { type: "json" };

const PACKAGE = '0x936313e502e9cbf6e7a04fe2aeb4c60bc0acd69729acc7a19921b33bebf72d03';
const CLOCK_ID = '0x6';
const RPC_URL = 'https://fullnode.testnet.sui.io:443';

const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = new SuiJsonRpcClient({ url: RPC_URL } as any);

// Window is open when time_in_hour ∈ [0,300) ∪ [1800,2100)
// i.e. first 5 minutes and the 30:00–35:00 mark of every hour (UTC)
function msUntilWindowOpen(): number {
  const nowSec = Math.floor(Date.now() / 1000);
  const timeInHour = nowSec % 3600;
  if ((timeInHour >= 0 && timeInHour < 300) || (timeInHour >= 1800 && timeInHour < 2100)) return 0;
  const secsUntilOpen = timeInHour < 1800 ? 1800 - timeInHour : 3600 - timeInHour;
  return secsUntilOpen * 1000;
}

(async () => {
  const myAddress = keypair.toSuiAddress();
  console.log('Address:', myAddress);

  while (true) {
    const waitMs = msUntilWindowOpen();
    if (waitMs === 0) break;
    const nowSec = Math.floor(Date.now() / 1000);
    console.log(`Window closed (time_in_hour=${nowSec % 3600}s). Waiting ${Math.ceil(waitMs / 1000)}s...`);
    await new Promise(r => setTimeout(r, Math.min(waitMs, 10_000)));
  }

  const nowSec = Math.floor(Date.now() / 1000);
  console.log(`Window open (time_in_hour=${nowSec % 3600}s). Submitting...`);

  const tx = new Transaction();
  const flag = tx.moveCall({
    target: `${PACKAGE}::moving_window::extract_flag`,
    arguments: [tx.object(CLOCK_ID)],
  });
  tx.transferObjects([flag], myAddress);

  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showObjectChanges: true, showEffects: true },
  });
  console.log('Digest:', result.digest);

  if (result.effects?.status?.status !== 'success') {
    console.error('Transaction failed:', result.effects?.status);
    process.exit(1);
  }

  const flagObj = result.objectChanges?.find(
    (c: any) => c.type === 'created' && c.objectType?.includes('::flag::Flag')
  ) as any;
  if (flagObj) {
    console.log('Flag object ID:', flagObj.objectId);
  }
})();
