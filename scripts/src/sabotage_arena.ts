import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import keyPairJson from "../keypair.json" with { type: "json" };
import { sleep } from './helpers.ts';

const PACKAGE = '0x936313e502e9cbf6e7a04fe2aeb4c60bc0acd69729acc7a19921b33bebf72d03';
const DEPLOY_TX = 'FDM3FUBJStmycZp1tb7ucVH7oA66iVo1uVHoy1iA8he1';
const CLOCK_ID = '0x6';
const SHIELD_THRESHOLD = 12n;
const COOLDOWN_MS = 600_000; // 10 minutes
const RPC_URL = 'https://fullnode.testnet.sui.io:443';

const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = new SuiJsonRpcClient({ url: RPC_URL } as any);

async function getArenaId(): Promise<string> {
  const deployTx = await client.getTransactionBlock({
    digest: DEPLOY_TX,
    options: { showObjectChanges: true },
  });
  const arena = (deployTx.objectChanges as any[])?.find(
    (c: any) => c.type === 'created' && c.objectType?.includes('::sabotage_arena::Arena')
  );
  if (!arena) throw new Error('Arena not found in deploy tx');
  return arena.objectId;
}

async function getPlayerState(arenaId: string, address: string) {
  const arena = await client.getObject({ id: arenaId, options: { showContent: true } });
  const fields = (arena.data?.content as any)?.fields;
  const playersTableId = fields?.players?.fields?.id?.id;
  if (!playersTableId) return null;

  try {
    const entry = await client.getDynamicFieldObject({
      parentId: playersTableId,
      name: { type: 'address', value: address },
    });
    const pf = (entry.data?.content as any)?.fields?.value?.fields;
    if (!pf) return null;
    return { shield: BigInt(pf.shield ?? 0), last_action_ms: BigInt(pf.last_action_ms ?? 0) };
  } catch {
    return null;
  }
}

(async () => {
  const myAddress = keypair.toSuiAddress();
  console.log('Address:', myAddress);

  const arenaId = await getArenaId();
  console.log('Arena:', arenaId);

  let player = await getPlayerState(arenaId, myAddress);

  if (!player) {
    console.log('Registering...');
    const tx = new Transaction();
    tx.moveCall({
      target: `${PACKAGE}::sabotage_arena::register`,
      arguments: [tx.object(arenaId), tx.object(CLOCK_ID)],
    });
    const result = await client.signAndExecuteTransaction({
      signer: keypair, transaction: tx, options: { showEffects: true },
    });
    if (result.effects?.status?.status !== 'success') {
      console.error('Register failed:', result.effects?.status);
      process.exit(1);
    }
    console.log('Registered!');
    player = { shield: 0n, last_action_ms: 0n };
  } else {
    console.log(`Already registered. Shield: ${player.shield}/${SHIELD_THRESHOLD}`);
  }

  // Build shield to threshold (12 builds × 10-min cooldown = ~2 hours total)
  while (player.shield < SHIELD_THRESHOLD) {
    const nowMs = BigInt(Date.now());
    const cooldownExpiresMs = player.last_action_ms + BigInt(COOLDOWN_MS);

    if (nowMs < cooldownExpiresMs) {
      const waitMs = Number(cooldownExpiresMs - nowMs) + 1000;
      console.log(`Shield: ${player.shield}/${SHIELD_THRESHOLD}. Cooldown. Waiting ${Math.ceil(waitMs / 1000)}s...`);
      await sleep(waitMs);
    }

    console.log(`Building shield (${player.shield} → ${player.shield + 1n})...`);
    const tx = new Transaction();
    tx.moveCall({
      target: `${PACKAGE}::sabotage_arena::build`,
      arguments: [tx.object(arenaId), tx.object(CLOCK_ID)],
    });
    const result = await client.signAndExecuteTransaction({
      signer: keypair, transaction: tx, options: { showEffects: true },
    });

    if (result.effects?.status?.status === 'success') {
      console.log(`  Built! Digest: ${result.digest}`);
    } else {
      console.error(`  Build failed: ${JSON.stringify(result.effects?.status)}`);
      await sleep(2000);
    }

    // Re-read on-chain state to stay in sync
    const onchain = await getPlayerState(arenaId, myAddress);
    if (onchain) player = onchain;
  }

  console.log(`Shield at ${player.shield}! Claiming flag...`);
  const tx = new Transaction();
  const flag = tx.moveCall({
    target: `${PACKAGE}::sabotage_arena::claim_flag`,
    arguments: [tx.object(arenaId), tx.object(CLOCK_ID)],
  });
  tx.transferObjects([flag], myAddress);

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
