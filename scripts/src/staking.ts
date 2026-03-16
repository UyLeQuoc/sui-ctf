import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import keyPairJson from "../keypair.json" with { type: "json" };

const PACKAGE = '0x936313e502e9cbf6e7a04fe2aeb4c60bc0acd69729acc7a19921b33bebf72d03';
const DEPLOY_TX = 'FDM3FUBJStmycZp1tb7ucVH7oA66iVo1uVHoy1iA8he1';
const CLOCK_ID = '0x6';
const MIN_STAKE = 1_000_000_000n; // 1 SUI
const MIN_HOURS = 168n;
const RPC_URL = 'https://fullnode.testnet.sui.io:443';

const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = new SuiJsonRpcClient({ url: RPC_URL } as any);

async function getStakingPoolId(): Promise<string> {
  const deployTx = await client.getTransactionBlock({
    digest: DEPLOY_TX,
    options: { showObjectChanges: true },
  });
  const pool = (deployTx.objectChanges as any[])?.find(
    (c: any) => c.type === 'created' && c.objectType?.includes('::staking::StakingPool')
  );
  if (!pool) throw new Error('StakingPool not found in deploy tx');
  return pool.objectId;
}

async function getExistingReceipt(): Promise<string | null> {
  const { data } = await client.getOwnedObjects({
    owner: keypair.toSuiAddress(),
    filter: { StructType: `${PACKAGE}::staking::StakeReceipt` },
    options: { showContent: true },
  });
  if (data.length === 0 || !data[0].data) return null;
  return data[0].data.objectId;
}

async function getReceiptFields(id: string) {
  const obj = await client.getObject({ id, options: { showContent: true } });
  const fields = (obj.data?.content as any)?.fields;
  return {
    amount: BigInt(fields?.amount ?? 0),
    hours_staked: BigInt(fields?.hours_staked ?? 0),
    last_update_timestamp: BigInt(fields?.last_update_timestamp ?? 0),
  };
}

(async () => {
  const myAddress = keypair.toSuiAddress();
  console.log('Address:', myAddress);

  const stakingPoolId = await getStakingPoolId();
  console.log('StakingPool:', stakingPoolId);

  let receiptId = await getExistingReceipt();

  if (!receiptId) {
    console.log(`No receipt found. Staking ${MIN_STAKE} MIST (1 SUI)...`);

    const tx = new Transaction();
    const [stake] = tx.splitCoins(tx.gas, [tx.pure.u64(MIN_STAKE)]);
    const receipt = tx.moveCall({
      target: `${PACKAGE}::staking::stake`,
      arguments: [tx.object(stakingPoolId), stake, tx.object(CLOCK_ID)],
    });
    tx.transferObjects([receipt], myAddress);

    const result = await client.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: { showObjectChanges: true, showEffects: true },
    });

    if (result.effects?.status?.status !== 'success') {
      console.error('Stake failed:', result.effects?.status);
      process.exit(1);
    }

    const receiptObj = (result.objectChanges as any[])?.find(
      (c: any) => c.type === 'created' && c.objectType?.includes('StakeReceipt')
    );
    receiptId = receiptObj?.objectId;
    console.log('StakeReceipt:', receiptId);
    console.log('Staked! Run again in 168 hours to claim your flag.');
    process.exit(0);
  }

  console.log('Existing StakeReceipt:', receiptId);
  const fields = await getReceiptFields(receiptId!);
  const nowMs = BigInt(Date.now());
  const elapsedHours = (nowMs - fields.last_update_timestamp) / 3_600_000n;
  const totalHours = fields.hours_staked + elapsedHours;

  console.log(`Amount: ${fields.amount} MIST | Hours staked: ${fields.hours_staked} + ~${elapsedHours} elapsed = ${totalHours} total`);

  if (totalHours < MIN_HOURS) {
    console.log(`Need ${MIN_HOURS - totalHours} more hour(s). Come back later.`);
    process.exit(0);
  }

  console.log('168h reached! Claiming flag...');
  const tx = new Transaction();
  const updatedReceipt = tx.moveCall({
    target: `${PACKAGE}::staking::update_receipt`,
    arguments: [tx.object(receiptId!), tx.object(CLOCK_ID)],
  });
  const [flag, returnedCoin] = tx.moveCall({
    target: `${PACKAGE}::staking::claim_flag`,
    arguments: [tx.object(stakingPoolId), updatedReceipt, tx.object(CLOCK_ID)],
  });
  tx.transferObjects([flag, returnedCoin], myAddress);

  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showObjectChanges: true, showEffects: true },
  });
  console.log('Digest:', result.digest);

  if (result.effects?.status?.status !== 'success') {
    console.error('Claim failed:', result.effects?.status);
    process.exit(1);
  }

  const flagObj = (result.objectChanges as any[])?.find(
    (c: any) => c.type === 'created' && c.objectType?.includes('::flag::Flag')
  );
  if (flagObj) console.log('Flag object ID:', flagObj.objectId);
})();
