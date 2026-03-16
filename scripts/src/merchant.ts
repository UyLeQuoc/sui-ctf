import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import keyPairJson from "../keypair.json" with { type: "json" };

const PACKAGE = '0x936313e502e9cbf6e7a04fe2aeb4c60bc0acd69729acc7a19921b33bebf72d03';
const COST_PER_FLAG = 3_849_000n;
const RPC_URL = 'https://fullnode.testnet.sui.io:443';

const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = new SuiJsonRpcClient({ url: RPC_URL } as any);

async function getUsdcCoinType(): Promise<string> {
  const module = await client.getNormalizedMoveModule({ package: PACKAGE, module: 'merchant' });
  const fn = module.exposedFunctions['buy_flag'];
  const coinParam = fn.parameters[0] as any;
  const usdcStruct = coinParam?.Struct?.typeArguments?.[0]?.Struct;
  if (!usdcStruct) throw new Error('Could not extract USDC type: ' + JSON.stringify(coinParam));
  return `${usdcStruct.address}::${usdcStruct.module}::${usdcStruct.name}`;
}

(async () => {
  const myAddress = keypair.toSuiAddress();
  console.log('Address:', myAddress);

  console.log('Discovering USDC coin type...');
  const usdcType = await getUsdcCoinType();
  console.log('USDC type:', usdcType);

  const { data: usdcCoins } = await client.getCoins({ owner: myAddress, coinType: usdcType });
  if (usdcCoins.length === 0) {
    console.error(`No USDC found. Acquire at least ${COST_PER_FLAG} base units on testnet.`);
    process.exit(1);
  }

  const totalUsdc = usdcCoins.reduce((sum: bigint, c: any) => sum + BigInt(c.balance), 0n);
  console.log(`USDC balance: ${totalUsdc} (need ${COST_PER_FLAG})`);
  if (totalUsdc < COST_PER_FLAG) {
    console.error(`Insufficient USDC.`);
    process.exit(1);
  }

  const tx = new Transaction();
  const primaryCoin = tx.object(usdcCoins[0].coinObjectId);
  if (usdcCoins.length > 1) {
    tx.mergeCoins(primaryCoin, usdcCoins.slice(1).map((c: any) => tx.object(c.coinObjectId)));
  }
  const [payment] = tx.splitCoins(primaryCoin, [tx.pure.u64(COST_PER_FLAG)]);

  const flag = tx.moveCall({
    target: `${PACKAGE}::merchant::buy_flag`,
    arguments: [payment],
  });
  tx.transferObjects([flag], myAddress);

  console.log('Buying flag...');
  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showObjectChanges: true, showEffects: true },
  });
  console.log('Digest:', result.digest);

  if (result.effects?.status?.status !== 'success') {
    console.error('Failed:', result.effects?.status);
    process.exit(1);
  }

  const flagObj = result.objectChanges?.find(
    (c: any) => c.type === 'created' && c.objectType?.includes('::flag::Flag')
  ) as any;
  if (flagObj) console.log('Flag object ID:', flagObj.objectId);
})();
