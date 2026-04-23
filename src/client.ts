/**
 * Client SDK: createSession + wrapFetch.
 *
 * createSession flow:
 *  1. GET /supported → read facilitator pubkey (spender) + facilitator URL metadata
 *  2. Build IncoToken `approve_checked(encryptedCap)` tx:
 *       - simulate bare approve to discover source ATA's delegated_amount handle
 *       - derive allowance PDA = [handle_le16, facilitator_pubkey]
 *       - rebuild with allowance PDA in remaining_accounts
 *  3. User signs the approve tx (partial — facilitator's /sessions will pass through Kora
 *     for fee-payer signature & submission so user spends zero SOL)
 *  4. User signs an Ed25519 auth message (canonical JSON of session intent)
 *  5. POST /sessions with { approveTxBase64, authMessage, authSignature, ... }
 *  6. Facilitator submits approve via Kora, validates, stores session row, returns handle
 *
 * wrapFetch:
 *  - intercepts 402 response
 *  - reads PAYMENT-REQUIRED header (v2) or body (v1)
 *  - finds accepts entry with scheme="session" and matching network
 *  - retries with PAYMENT-SIGNATURE header = base64(PaymentPayload with sessionId)
 */

import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";

import {
  INCO_TOKEN_PROGRAM_ID,
  getIncoAssociatedTokenAddress,
  getAllowancePda,
  parseIncoAccountFromBase64,
  decimalToBaseUnits,
  canonicalSessionAuthMessage,
  ixApproveChecked,
  ixCreateIdempotent,
  simulateForAccounts,
} from "./solana";

import {
  CreateSessionOptions,
  CreateSessionRequest,
  CreateSessionResponse,
  PaymentPayload,
  PaymentRequired,
  SessionHandle,
  SessionPaymentPayloadBody,
  SCHEME,
} from "./types";

function defaultRpc(network: string): string {
  if (network === "solana:devnet") return "https://api.devnet.solana.com";
  if (network === "solana:mainnet")
    return "https://api.mainnet-beta.solana.com";
  throw new Error(`Unknown network: ${network}`);
}

function b64encode(s: string | Uint8Array): string {
  if (typeof s === "string") return Buffer.from(s, "utf8").toString("base64");
  return Buffer.from(s).toString("base64");
}

function b64decodeToString(s: string): string {
  return Buffer.from(s, "base64").toString("utf8");
}

async function encryptCap(cap: bigint): Promise<string> {
  // @inco/solana-sdk is an ESM-only package — dynamic-import on demand.
  const mod: any = await import("@inco/solana-sdk/encryption");
  return mod.encryptValue(cap);
}

function hexToBuffer(hex: string): Buffer {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Buffer.from(clean, "hex");
}

/**
 * Create a private session with the facilitator. Returns a handle whose `.fetch`
 * transparently settles pay-per-call charges.
 */
export async function createSession(
  opts: CreateSessionOptions
): Promise<SessionHandle> {
  const decimals = opts.decimals ?? 6;
  const rpcUrl = opts.solanaRpcUrl ?? defaultRpc(opts.network);
  const connection = new Connection(rpcUrl, "confirmed");

  // 1. discover facilitator pubkey from /supported
  const supportedRes = await fetch(`${opts.facilitatorUrl}/supported`);
  if (!supportedRes.ok) {
    throw new Error(
      `GET /supported failed: ${supportedRes.status} ${await supportedRes.text()}`
    );
  }
  const supported = (await supportedRes.json()) as {
    kinds: { extra?: { facilitatorAddress?: string } }[];
  };
  const facilitatorPubkeyStr = supported.kinds.find(
    (k) => k.extra?.facilitatorAddress
  )?.extra?.facilitatorAddress;
  if (!facilitatorPubkeyStr) {
    throw new Error(
      "/supported response did not advertise a facilitatorAddress in any kind.extra"
    );
  }
  const facilitatorPubkey = new PublicKey(facilitatorPubkeyStr);

  // 2. derive source ATA + encrypt cap
  const userPubkey = new PublicKey(opts.signer.publicKey);
  const mint = new PublicKey(opts.asset);
  const recipient = new PublicKey(opts.recipient);
  const sourceAta = getIncoAssociatedTokenAddress(userPubkey, mint);

  const capBaseUnits = decimalToBaseUnits(opts.cap, decimals);
  if (capBaseUnits <= 0n) {
    throw new Error(`cap must be > 0 (got "${opts.cap}")`);
  }
  const capCiphertextHex = await encryptCap(capBaseUnits);
  const ciphertext = hexToBuffer(capCiphertextHex);

  // 3. simulate a bare approve (no remaining_accounts) to extract the delegated_amount handle,
  //    then rebuild with the real allowance PDA in remaining_accounts.
  const bareApprove = ixApproveChecked({
    source: sourceAta,
    mint,
    delegate: facilitatorPubkey,
    owner: userPubkey,
    ciphertext,
    decimals,
    allowancePda: null,
  });
  const simTx = new Transaction();
  // ensure source ATA exists if user has never interacted — idempotent create
  simTx.add(
    ixCreateIdempotent({
      payer: facilitatorPubkey,
      ata: sourceAta,
      wallet: userPubkey,
      mint,
    })
  );
  simTx.add(bareApprove);
  simTx.feePayer = facilitatorPubkey;
  const { blockhash } = await connection.getLatestBlockhash();
  simTx.recentBlockhash = blockhash;
  const sim = await simulateForAccounts(connection, simTx, [sourceAta]);
  if (sim.err) {
    throw new Error(
      `approve simulation failed: ${JSON.stringify(sim.err)}`
    );
  }
  const sourceData = sim.accountsData[0];
  if (!sourceData) {
    throw new Error(
      "approve simulation returned no source account data — is IncoToken deployed on this network?"
    );
  }
  const view = parseIncoAccountFromBase64(sourceData);
  console.log(
    `[createSession] sim view: amount=0x${view.amount.toString(16)} delegate=${view.delegate} delegatedAmount=0x${view.delegatedAmount.toString(16)}`
  );
  if (view.delegatedAmount === 0n) {
    throw new Error(
      `approve simulate did not produce a delegated_amount handle`
    );
  }
  const realAllowancePda = getAllowancePda(view.delegatedAmount, facilitatorPubkey);
  console.log(
    `[createSession] allowance PDA: ${realAllowancePda.toBase58()} (facilitator=${facilitatorPubkey.toBase58()})`
  );

  // 4. final approve tx
  // Inco Lightning's Allow CPI creates an allowance PDA paid for by `owner` (the user).
  // Our users are gasless (0 SOL), so we front-transfer ~0.002 SOL facilitator → user
  // in the same tx to cover the rent. Facilitator's fee-payer signature doubles for the transfer.
  const realApprove = ixApproveChecked({
    source: sourceAta,
    mint,
    delegate: facilitatorPubkey,
    owner: userPubkey,
    ciphertext,
    decimals,
    allowancePda: realAllowancePda,
  });
  const tx = new Transaction();
  tx.add(
    SystemProgram.transfer({
      fromPubkey: facilitatorPubkey,
      toPubkey: userPubkey,
      lamports: 2_000_000, // 0.002 SOL to cover allowance PDA rent (~0.00096 SOL)
    })
  );
  tx.add(
    ixCreateIdempotent({
      payer: facilitatorPubkey,
      ata: sourceAta,
      wallet: userPubkey,
      mint,
    })
  );
  tx.add(realApprove);
  tx.feePayer = facilitatorPubkey;
  const { blockhash: bh2 } = await connection.getLatestBlockhash();
  tx.recentBlockhash = bh2;

  // 5. user partially signs (as owner); facilitator+Kora will add fee-payer sig on submit
  const serializedUnsigned = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
  const signedB64 = await opts.signer.signTransaction(serializedUnsigned);

  // 6. sign session auth message
  const expirationUnix =
    Math.floor(Date.now() / 1000) + opts.expirationSeconds;
  const nonce = Buffer.from(
    crypto.getRandomValues(new Uint8Array(16))
  ).toString("hex");
  const authMessage = canonicalSessionAuthMessage({
    user: userPubkey.toBase58(),
    spender: facilitatorPubkey.toBase58(),
    asset: mint.toBase58(),
    recipient: recipient.toBase58(),
    cap: capBaseUnits.toString(),
    expirationUnix,
    network: opts.network,
    nonce,
  });
  const authSignatureBytes = await opts.signer.signMessage(
    new TextEncoder().encode(authMessage)
  );
  const authSignature = b64encode(authSignatureBytes);

  // 7. POST /sessions — facilitator submits approve via Kora + stores session
  const body: CreateSessionRequest & { approveTxBase64: string } = {
    user: userPubkey.toBase58(),
    asset: mint.toBase58(),
    recipient: recipient.toBase58(),
    cap: capBaseUnits.toString(),
    expirationUnix,
    network: opts.network,
    // NOTE: approveTxSignature is filled by facilitator after submission; spec-wise we send the tx
    approveTxSignature: "",
    authMessage: b64encode(authMessage),
    authSignature,
    approveTxBase64: signedB64,
  } as CreateSessionRequest & { approveTxBase64: string };

  const sessionRes = await fetch(`${opts.facilitatorUrl}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!sessionRes.ok) {
    throw new Error(
      `POST /sessions failed: ${sessionRes.status} ${await sessionRes.text()}`
    );
  }
  const session = (await sessionRes.json()) as CreateSessionResponse;

  return {
    sessionId: session.sessionId,
    user: session.user,
    spender: session.spender,
    asset: session.asset,
    recipient: session.recipient,
    cap: session.cap,
    expirationUnix: session.expirationUnix,
    network: session.network,
    facilitatorUrl: opts.facilitatorUrl,
    fetch: wrapFetch(session.sessionId, opts.facilitatorUrl),
  };
}

/**
 * Returns a fetch-compatible function that transparently pays 402s using the given session.
 */
export function wrapFetch(
  sessionId: string,
  facilitatorUrl: string
): typeof fetch {
  const wrapped: typeof fetch = async (input, init) => {
    const first = await fetch(input as any, init as any);
    if (first.status !== 402) return first;

    // 1. look for PAYMENT-REQUIRED header (x402 v2)
    let pr: PaymentRequired | null = null;
    const v2Header =
      first.headers.get("PAYMENT-REQUIRED") ||
      first.headers.get("payment-required");
    if (v2Header) {
      try {
        pr = JSON.parse(b64decodeToString(v2Header)) as PaymentRequired;
      } catch {
        pr = null;
      }
    }
    if (!pr) {
      // fallback to v1 body
      try {
        pr = (await first.clone().json()) as PaymentRequired;
      } catch {
        return first;
      }
    }

    const accept = pr.accepts?.find((a) => a.scheme === SCHEME);
    if (!accept) return first;

    const payloadBody: SessionPaymentPayloadBody = {
      sessionId,
      amount: accept.amount,
    };
    const payload: PaymentPayload = {
      x402Version: pr.x402Version || 2,
      accepted: accept,
      payload: payloadBody,
      resource:
        typeof input === "string"
          ? { url: input }
          : { url: (input as Request).url },
    };
    const payloadB64 = b64encode(JSON.stringify(payload));

    // facilitator URL is the resource URL here; header carries sessionId
    const headers = new Headers((init as RequestInit | undefined)?.headers || {});
    headers.set("PAYMENT-SIGNATURE", payloadB64);
    headers.set("X-PAYMENT", payloadB64); // v1 fallback

    const retry = await fetch(input as any, {
      ...(init as RequestInit | undefined),
      headers,
    });
    return retry;
  };
  // surface facilitator URL for debugging
  (wrapped as any).facilitatorUrl = facilitatorUrl;
  return wrapped;
}
