import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import keyPairJson from "../keypair.json" with { type: "json" };

const PACKAGE = '0xaff30ff9a4b40845d8bdc91522a2b8e8e542ee41c0855f5cb21a652a00c45e96';
const RANDOM_ID = '0x8';
const REQUIRED_PAYMENT = 12_000_000n;
const USDC_TYPE = '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC';
const RPC_URL = 'https://fullnode.testnet.sui.io:443';

const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = new SuiJsonRpcClient({ url: RPC_URL } as any);

async function getUsdcCoins() {
  const { data } = await client.getCoins({ owner: keypair.toSuiAddress(), coinType: USDC_TYPE });
  return data as any[];
}

// Step 1: open_lootbox → MaybeFlag (costs 12 USDC)
async function openLootbox(usdcCoins: any[]): Promise<string | null> {
  const tx = new Transaction();
  const primary = tx.object(usdcCoins[0].coinObjectId);
  if (usdcCoins.length > 1) {
    tx.mergeCoins(primary, usdcCoins.slice(1).map((c: any) => tx.object(c.coinObjectId)));
  }
  const [payment] = tx.splitCoins(primary, [tx.pure.u64(REQUIRED_PAYMENT)]);
  const maybeFlag = tx.moveCall({
    target: `${PACKAGE}::lootboxes::open_lootbox`,
    arguments: [payment, tx.object(RANDOM_ID)],
  });
  tx.transferObjects([maybeFlag], keypair.toSuiAddress());

  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showObjectChanges: true, showEffects: true },
  });
  if (result.effects?.status?.status !== 'success') return null;

  await client.waitForTransaction({ digest: result.digest });

  return (result.objectChanges as any[])?.find(
    (c: any) => c.type === 'created' && c.objectType?.includes('::lootboxes::MaybeFlag')
  )?.objectId ?? null;
}

// Step 2: extract_flag → Flag OR abort ENoFlag (abort code 0)
async function extractFlag(maybeFlagId: string): Promise<string | null> {
  const tx = new Transaction();
  const flag = tx.moveCall({
    target: `${PACKAGE}::lootboxes::extract_flag`,
    arguments: [tx.object(maybeFlagId)],
  });
  tx.transferObjects([flag], keypair.toSuiAddress());

  try {
    const result = await client.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: { showObjectChanges: true, showEffects: true },
    });
    if (result.effects?.status?.status !== 'success') return null;
    return (result.objectChanges as any[])?.find(
      (c: any) => c.type === 'created' && c.objectType?.includes('::flag::Flag')
    )?.objectId ?? null;
  } catch (e: any) {
    // ENoFlag (abort code 0) — no flag in this MaybeFlag, need a new lootbox
    const abortCode = e?.executionError?.MoveAbort?.abortCode;
    if (abortCode === '0') return null;
    throw e;
  }
}

(async () => {
  const myAddress = keypair.toSuiAddress();
  console.log('Address:', myAddress);

  let attempt = 0;

  while (true) {
    const coins = await getUsdcCoins();
    const total = coins.reduce((s: bigint, c: any) => s + BigInt(c.balance), 0n);

    if (total < REQUIRED_PAYMENT) {
      console.log(`Insufficient USDC: ${Number(total) / 1e6} USDC. Need 12 USDC.`);
      break;
    }

    attempt++;
    console.log(`\nAttempt ${attempt} | USDC: ${Number(total) / 1e6}`);

    const maybeFlagId = await openLootbox(coins);
    if (!maybeFlagId) { console.error('open_lootbox failed'); process.exit(1); }
    console.log(`  MaybeFlag: ${maybeFlagId}`);

    const flagId = await extractFlag(maybeFlagId);
    if (flagId) {
      console.log(`\nFlag captured on attempt ${attempt}!`);
      console.log('Flag object ID:', flagId);
      break;
    }
    console.log('  No flag. Opening a new lootbox...');
  }
})();
