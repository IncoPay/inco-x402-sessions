/**
 * Solana + Inco helpers: program IDs, PDA derivations, tx builders, handle extraction.
 *
 * Design notes:
 * - Session semantics on Solana+Inco use IncoToken's `approve` + delegated `transfer`.
 * - User calls approve(cap_ciphertext) once → sets source_ata.delegate = facilitator,
 *   source_ata.delegated_amount = cap.
 * - Facilitator calls transfer(amount_ciphertext) as authority=facilitator, debiting
 *   source_ata.amount AND source_ata.delegated_amount atomically via Inco Lightning CPI.
 * - allowance PDAs in remaining_accounts are *decrypt* rights, not spending caps.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Ed25519Program,
} from "@solana/web3.js";

export const INCO_TOKEN_PROGRAM_ID = new PublicKey(
  "9Cir3JKBcQ1mzasrQNKWMiGVZvYu3dxvfkGeQ6mohWWi"
);
export const INCO_LIGHTNING_PROGRAM_ID = new PublicKey(
  "5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj"
);

/**
 * Derive the IncoToken ATA for (wallet, mint).
 * Seeds: [wallet, IncoTokenProgramId, mint]
 */
export function getIncoAssociatedTokenAddress(
  wallet: PublicKey,
  mint: PublicKey
): PublicKey {
  const [addr] = PublicKey.findProgramAddressSync(
    [wallet.toBuffer(), INCO_TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    INCO_TOKEN_PROGRAM_ID
  );
  return addr;
}

/**
 * Derive an Inco Lightning allowance PDA.
 * Seeds: [handle_le16, allowedAddress]
 */
export function getAllowancePda(
  handle: bigint,
  allowedAddress: PublicKey
): PublicKey {
  const buf = Buffer.alloc(16);
  let h = handle;
  for (let i = 0; i < 16; i++) {
    buf[i] = Number(h & BigInt(0xff));
    h >>= BigInt(8);
  }
  const [pda] = PublicKey.findProgramAddressSync(
    [buf, allowedAddress.toBuffer()],
    INCO_LIGHTNING_PROGRAM_ID
  );
  return pda;
}

function readU128LE(buf: Buffer, offset: number): bigint {
  let h = 0n;
  for (let i = 15; i >= 0; i--) h = h * 256n + BigInt(buf[offset + i]);
  return h;
}

/**
 * Parse an IncoAccount from raw bytes.
 *
 * Layout (Anchor default encoding):
 *   [0..8]       discriminator
 *   [8..40]      mint (Pubkey)
 *   [40..72]     owner (Pubkey)
 *   [72..88]     amount (Euint128 = u128 LE)
 *   [88..]       delegate (COption<Pubkey>): 1-byte tag (0=None, 1=Some) + 32-byte pubkey if Some
 *   [...]        state (AccountState enum, 1 byte: 0=Uninit, 1=Init, 2=Frozen)
 *   [...]        is_native (COption<u64>): 1-byte tag + 8-byte u64 if Some
 *   [...]        delegated_amount (Euint128 = u128 LE)
 *   [...]        close_authority (COption<Pubkey>)
 */
export interface IncoAccountView {
  amount: bigint;
  delegate: string | null;
  delegatedAmount: bigint;
}

export function parseIncoAccountFromBase64(b64: string): IncoAccountView {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 88) {
    throw new Error(`IncoAccount too short: ${buf.length} bytes`);
  }
  const amount = readU128LE(buf, 72);
  let off = 88;
  const delegateTag = buf[off];
  off += 1;
  let delegate: string | null = null;
  if (delegateTag === 1) {
    const { PublicKey } = require("@solana/web3.js");
    delegate = new PublicKey(buf.slice(off, off + 32)).toBase58();
    off += 32;
  }
  // state
  off += 1;
  // is_native (COption<u64>)
  const isNativeTag = buf[off];
  off += 1;
  if (isNativeTag === 1) off += 8;
  const delegatedAmount = readU128LE(buf, off);
  return { amount, delegate, delegatedAmount };
}

/** Legacy helper kept for transfer path — just the amount handle at 72..88. */
export function extractAmountHandleFromAccountData(
  base64Data: string
): bigint {
  const buf = Buffer.from(base64Data, "base64");
  if (buf.length < 88) {
    throw new Error(
      `IncoAccount data too short: ${buf.length} bytes`
    );
  }
  return readU128LE(buf, 72);
}

/**
 * Convert a decimal amount string (e.g. "1.5") to base-units bigint given decimals.
 */
export function decimalToBaseUnits(amount: string, decimals: number): bigint {
  const [whole, frac = ""] = amount.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const s = (whole || "0") + padded;
  return BigInt(s.replace(/^0+(?=\d)/, "") || "0");
}

/**
 * Build the canonical JSON the user signs for session authorization.
 * Keys are sorted for deterministic signing.
 */
export function canonicalSessionAuthMessage(params: {
  user: string;
  spender: string;
  asset: string;
  recipient: string;
  cap: string;
  expirationUnix: number;
  network: string;
  nonce: string;
}): string {
  const { user, spender, asset, recipient, cap, expirationUnix, network, nonce } =
    params;
  return JSON.stringify({
    asset,
    cap,
    expirationUnix,
    network,
    nonce,
    recipient,
    spender,
    user,
  });
}

// ---------- Anchor-free instruction builders ----------
// Discriminators from the IncoToken IDL.

const DISC_APPROVE_CHECKED = Buffer.from([47, 197, 254, 42, 58, 201, 58, 109]);
const DISC_APPROVE = Buffer.from([69, 74, 217, 36, 115, 117, 97, 76]);
const DISC_TRANSFER = Buffer.from([163, 52, 200, 231, 140, 3, 69, 186]);
const DISC_CREATE_IDEMPOTENT = Buffer.from([
  143, 88, 34, 91, 112, 20, 245, 59,
]);

function encodeBytes(b: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length, 0);
  return Buffer.concat([len, b]);
}

/**
 * Build an `approve_checked` instruction. Signed by owner; delegates control of ATA to `delegate`.
 * Pass `allowancePda: null` for a bare-simulate version (no remaining_accounts) used to extract
 * the handle before the real submission.
 */
export function ixApproveChecked(args: {
  source: PublicKey;
  mint: PublicKey;
  delegate: PublicKey;
  owner: PublicKey;
  ciphertext: Buffer;
  decimals: number;
  allowancePda: PublicKey | null;
}): TransactionInstruction {
  const data = Buffer.concat([
    DISC_APPROVE_CHECKED,
    encodeBytes(args.ciphertext),
    Buffer.from([0]),                // input_type
    Buffer.from([args.decimals]),
  ]);
  const keys = [
    { pubkey: args.source, isSigner: false, isWritable: true },
    { pubkey: args.mint, isSigner: false, isWritable: false },
    { pubkey: args.delegate, isSigner: false, isWritable: false },
    { pubkey: args.owner, isSigner: true, isWritable: true },
    { pubkey: INCO_LIGHTNING_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  if (args.allowancePda) {
    keys.push(
      { pubkey: args.allowancePda, isSigner: false, isWritable: true },
      { pubkey: args.delegate, isSigner: false, isWritable: false }
    );
  }
  return new TransactionInstruction({
    programId: INCO_TOKEN_PROGRAM_ID,
    keys,
    data,
  });
}

/**
 * Simpler approve (no decimals check). Used for cases where we don't have the mint handy.
 */
export function ixApprove(args: {
  source: PublicKey;
  delegate: PublicKey;
  owner: PublicKey;
  ciphertext: Buffer;
  allowancePda: PublicKey;
}): TransactionInstruction {
  const data = Buffer.concat([
    DISC_APPROVE,
    encodeBytes(args.ciphertext),
    Buffer.from([0]), // input_type
  ]);
  return new TransactionInstruction({
    programId: INCO_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: args.source, isSigner: false, isWritable: true },
      { pubkey: args.delegate, isSigner: false, isWritable: false },
      { pubkey: args.owner, isSigner: true, isWritable: true },
      { pubkey: INCO_LIGHTNING_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: args.allowancePda, isSigner: false, isWritable: true },
      { pubkey: args.delegate, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * `transfer` — authority is the delegate (facilitator). Debits source.delegated_amount + source.amount.
 * remaining_accounts: [source_allowance, source_owner, dest_allowance, dest_owner]
 */
export function ixTransfer(args: {
  source: PublicKey;
  destination: PublicKey;
  authority: PublicKey;
  ciphertext: Buffer;
  sourceAllowancePda: PublicKey;
  sourceOwner: PublicKey;
  destAllowancePda: PublicKey;
  destOwner: PublicKey;
}): TransactionInstruction {
  const data = Buffer.concat([
    DISC_TRANSFER,
    encodeBytes(args.ciphertext),
    Buffer.from([0]), // input_type
  ]);
  return new TransactionInstruction({
    programId: INCO_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: args.source, isSigner: false, isWritable: true },
      { pubkey: args.destination, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: INCO_LIGHTNING_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: args.sourceAllowancePda, isSigner: false, isWritable: true },
      { pubkey: args.sourceOwner, isSigner: false, isWritable: false },
      { pubkey: args.destAllowancePda, isSigner: false, isWritable: true },
      { pubkey: args.destOwner, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * `create_idempotent` — create IncoToken ATA if it doesn't exist.
 */
export function ixCreateIdempotent(args: {
  payer: PublicKey;
  ata: PublicKey;
  wallet: PublicKey;
  mint: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: INCO_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.ata, isSigner: false, isWritable: true },
      { pubkey: args.wallet, isSigner: false, isWritable: false },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: INCO_LIGHTNING_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: DISC_CREATE_IDEMPOTENT,
  });
}

/**
 * Simulate a tx to discover handles for remaining accounts (before real submission).
 * Returns the account data blobs so callers can extract handles from specific accounts.
 */
export async function simulateForAccounts(
  connection: Connection,
  tx: Transaction,
  accounts: PublicKey[]
): Promise<{ err: unknown; accountsData: (string | null)[] }> {
  const sim = await connection.simulateTransaction(tx, undefined, accounts);
  if (sim.value.err) {
    return {
      err: sim.value.err,
      accountsData: accounts.map(() => null),
    };
  }
  const out: (string | null)[] = [];
  for (const a of sim.value.accounts || []) {
    if (!a || !a.data) {
      out.push(null);
      continue;
    }
    out.push(a.data[0]);
  }
  return { err: null, accountsData: out };
}

export { SYSVAR_INSTRUCTIONS_PUBKEY, Ed25519Program };
