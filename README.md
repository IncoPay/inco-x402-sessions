# solana-x402-sessions

> **Sign once, settle many times** — confidential x402 micropayments on Solana, powered by Inco Lightning.

The user signs **one** on-chain `approve` allowance to the facilitator. After that, every API call settles a small confidential transfer (`transfer_with_authorization` over an IncoToken) on behalf of the user — no extra wallet popups, no gas, encrypted amounts on-chain.

---

## Install

```bash
npm install solana-x402-sessions @solana/web3.js
```

Peer-friendly with `@coral-xyz/anchor` and `@inco/solana-sdk`. The resource-server scheme plugin (`solana-x402-sessions/scheme`) is optional — only needed if you're plugging into [`@x402/core`](https://www.npmjs.com/package/@x402/core).

---

## Hosted facilitator

A reference facilitator runs on Solana **devnet** so you can wire a demo without operating anything yourself:

```
https://inco-facilitator-production.up.railway.app
```

Endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | liveness + facilitator pubkey + token mint |
| `GET` | `/supported` | x402 v1+v2 supported `kinds` (scheme: `session`, network: `solana:devnet`) |
| `POST` | `/sessions` | open a new session (the SDK calls this for you) |
| `GET` | `/sessions/:id` | inspect session state |
| `POST` | `/verify` | verify a session payment header (resource-server side) |
| `POST` | `/settle` | settle a per-call payment against an open session |
| `POST` | `/pay/{getAmount,verify,settle}` | classic single-payment x402 (no sessions) |

Devnet config:

| | |
|---|---|
| Token mint | `7crFMbJN7hxVhUPNcRRxTGr9nD3TnvpZ8pNZepA19wuB` (Inco-issued "USDC", 6 decimals) |
| Facilitator pubkey | `55LEmvuVgujxEvbrYBiDXBZmMxu3dMofVvT6uCq4q2xK` |
| IncoToken program | `9Cir3JKBcQ1mzasrQNKWMiGVZvYu3dxvfkGeQ6mohWWi` |
| Inco Lightning program | `5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj` |

---

## Client quickstart

```ts
import { createSession, wrapFetch, type ClientSvmSigner } from "solana-x402-sessions";
import { Transaction } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";

const FACILITATOR_URL = "https://inco-facilitator-production.up.railway.app";
const TOKEN_MINT      = "7crFMbJN7hxVhUPNcRRxTGr9nD3TnvpZ8pNZepA19wuB";
const RECIPIENT       = "55LEmvuVgujxEvbrYBiDXBZmMxu3dMofVvT6uCq4q2xK";

function MyChat() {
  const { publicKey, signMessage, signTransaction } = useWallet();

  async function openSession() {
    if (!publicKey || !signMessage || !signTransaction) return;

    const signer: ClientSvmSigner = {
      publicKey: publicKey.toBase58(),
      signMessage: async (msg) => signMessage(msg),
      signTransaction: async (txB64) => {
        const tx = Transaction.from(Buffer.from(txB64, "base64"));
        const signed = await signTransaction(tx);
        return (signed as Transaction)
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString("base64");
      },
    };

    const session = await createSession({
      facilitatorUrl: FACILITATOR_URL,
      network: "solana:devnet",
      asset: TOKEN_MINT,
      recipient: RECIPIENT,
      cap: "1",                  // 1 USDC total spending cap for this session
      expirationSeconds: 3600,   // session lives 1 hour
      signer,
      solanaRpcUrl: "https://api.devnet.solana.com",
    });

    // From now on, just call `session.fetch(...)` — every 402 from the resource
    // server is auto-retried with a payment header derived from the session.
    const res = await session.fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });
    console.log(await res.json());
  }
}
```

`session.fetch` is just a `wrapFetch(sessionId, facilitatorUrl)` — you can call it directly if you've persisted the session id (e.g. across page reloads):

```ts
import { wrapFetch } from "solana-x402-sessions";

const fetch = wrapFetch(savedSessionId, FACILITATOR_URL);
const res = await fetch("/api/chat", { method: "POST", body: ... });
```

---

## Resource-server side (optional)

If you're protecting an API endpoint with x402 sessions, the SDK exports a scheme plugin you can register with `@x402/core`'s `paymentProxy` / `x402ResourceServer`:

```ts
import { SessionIncoScheme } from "solana-x402-sessions/scheme";

const scheme = new SessionIncoScheme({
  facilitatorUrl: "https://inco-facilitator-production.up.railway.app",
  network: "solana:devnet",
  asset: "7crFMbJN7hxVhUPNcRRxTGr9nD3TnvpZ8pNZepA19wuB",
  recipient: "55LEmvuVgujxEvbrYBiDXBZmMxu3dMofVvT6uCq4q2xK",
  decimals: 6,
});
// register with x402ResourceServer / paymentProxy
```

Or — if you control the API directly — return `402` with a `PAYMENT-REQUIRED` header and let the SDK retry with `PAYMENT-SIGNATURE`:

```ts
// app/api/chat/route.ts (Next.js App Router)
import { NextRequest, NextResponse } from "next/server";

const FACILITATOR_URL = "https://inco-facilitator-production.up.railway.app";

export async function POST(req: NextRequest) {
  const sigHeader = req.headers.get("PAYMENT-SIGNATURE");
  if (!sigHeader) {
    const accepts = [{
      scheme: "session",
      network: "solana:devnet",
      asset: "7crFMbJN7hxVhUPNcRRxTGr9nD3TnvpZ8pNZepA19wuB",
      amount: "500000",  // 0.5 USDC (6 decimals)
      payTo: "55LEmvuVgujxEvbrYBiDXBZmMxu3dMofVvT6uCq4q2xK",
      maxTimeoutSeconds: 60,
      extra: { facilitatorUrl: FACILITATOR_URL, per: "message" },
    }];
    return new NextResponse(JSON.stringify({ x402Version: 2, accepts }), {
      status: 402,
      headers: {
        "content-type": "application/json",
        "PAYMENT-REQUIRED": Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64"),
      },
    });
  }

  // Forward to facilitator /settle
  const payload = JSON.parse(Buffer.from(sigHeader, "base64").toString());
  const settle = await fetch(`${FACILITATOR_URL}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      paymentPayload: payload,
      paymentRequirements: payload.accepted,
    }),
  }).then((r) => r.json());

  if (!settle.success) {
    return new NextResponse(
      JSON.stringify({ error: "settle_failed", details: settle }),
      {
        status: 402,
        headers: {
          "PAYMENT-RESPONSE": Buffer.from(JSON.stringify(settle)).toString("base64"),
        },
      },
    );
  }
  // … your real handler
  return NextResponse.json({ reply: "you paid 0.5 USDC ✓" });
}
```

---

## Architecture (one screen)

```
┌────────┐  signMessage + approveTx  ┌──────────────┐    on-chain
│ wallet │──────────────────────────►│  facilitator │ ◄──── approve(user, facilitator, cap)
│Phantom │                            └──────┬───────┘   on Solana via IncoToken
└────────┘                                   │
    │                                        │ per-call
    │  session.fetch("/api/chat") ─► 402 ─►  │ /settle ─► transfer_with_authorization
    │                          ◄─ response ◄ │            (encrypted ciphertext via Inco Lightning)
    │                                        │
    └────── Phantom never popped again, no SOL spent (gasless) ────────┘
```

- **Privacy**: amounts are `Euint128` ciphertexts on chain. The Covalidator (Inco TEE) signs the result for an on-chain Ed25519 verify, so settlements are confidential end-to-end.
- **Trust model**: total cap + expiry are **on-chain enforced** by the IncoToken `approve` allowance PDA. Per-call amount + recipient binding are off-chain enforced by the facilitator.
- **Refunds**: not needed. `approve` doesn't escrow; unused allowance stays in the user's IncoAccount.

---

## How Inco Lightning fits in

[Inco Lightning](https://docs.inco.org/svm/home) is the FHE+TEE primitive that makes amounts confidential on Solana. This SDK doesn't talk to it directly — the IncoToken Anchor program does, and the Covalidator (Inco's TEE service) lives behind the Anchor program.

### The two on-chain programs

| Program | Address | Job |
|---|---|---|
| **IncoToken** | `9Cir3JKBcQ1mzasrQNKWMiGVZvYu3dxvfkGeQ6mohWWi` | Anchor program. Owns `IncoMint` + `IncoAccount` PDAs. Exposes `initialize_mint`, `mint_to`, `transfer`, `approve`, `transfer_with_authorization`, `burn`, etc. — same API surface as SPL Token, but balances are FHE ciphertexts (`Euint128`). |
| **Inco Lightning** | `5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj` | FHE runtime. IncoToken does CPI into Lightning for `e_add`, `e_sub`, `e_ge`, etc. on encrypted handles. The Covalidator (off-chain TEE) processes the ciphertext arithmetic and writes back signed results. |

### Lifecycle of a session settle

1. **Client sends `PAYMENT-SIGNATURE` header** to the resource server. The header is base64-encoded `{ user, sessionId, amount, recipient, ... }`.
2. **Resource server forwards** the payload to the facilitator's `/settle`.
3. **Facilitator validates** off-chain: session exists, not expired, cumulative spent + amount ≤ cap, recipient matches what was signed in the auth message.
4. **Facilitator builds an Anchor tx** with two instructions:
   - `Ed25519SigVerify` — proves the user signed the auth message authorizing this session.
   - `IncoToken::transfer_with_authorization` — debits the user's encrypted balance, credits the merchant's encrypted balance, **inside Inco Lightning's TEE**. Plaintext amount never touches the chain.
5. **The IncoToken program CPIs into Inco Lightning** with the ciphertext handles. Lightning's TEE worker (Covalidator) computes `recipient.amount += amount` and `user.amount -= amount` over `Euint128` and signs the result.
6. **A new `Euint128` handle** is written back to both IncoAccounts. Anyone watching the chain sees opaque hashes — only the holder of an allowance PDA can later ask the Covalidator to decrypt.
7. **Facilitator's keypair pays the SOL fee**, signs as fee-payer, and submits. User pays nothing in SOL.

### Decrypting your own balance (client-side)

The encrypted balance handle is a u128 on-chain — meaningless until you ask Inco's Covalidator to decrypt it. `@inco/solana-sdk/attested-decrypt::decrypt(handles, { address, signMessage })` does this in three steps:

1. Reads each `handle` (decimal u128 string — *not* hex; the Covalidator parses with `BigInt(...)`).
2. Asks your wallet to sign the handle as a UTF-8 message — proves you own the account.
3. POSTs `{ handle, address, signature }` to the Covalidator. The Covalidator checks the on-chain allowance PDA (`[handle_le16, address]` under `5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj`), and if your address is whitelisted, returns the decrypted plaintext + an Ed25519 signature you can use for an on-chain `Ed25519Program` verify ix.

**Critical**: when minting / transferring, the *destination* user's pubkey must be in the allowance PDA's `remainingAccounts[1]` slot. Otherwise only the operator can decrypt — common bug; see Troubleshooting.

---

## API reference

### `createSession(opts)`

Opens a new x402 session by:

1. Building an unsigned `approve(user, facilitator, cap, expirationLedger)` tx via the IncoToken program.
2. Signing it with the user's wallet (Phantom / Solflare / any Solana Standard Wallet).
3. POSTing `{ approveTxSignature, authMessage, authSignature }` to `${facilitatorUrl}/sessions` so the facilitator records the session and can verify per-call settles.

| Option | Type | Notes |
|---|---|---|
| `facilitatorUrl` | `string` | required, e.g. `https://inco-facilitator-production.up.railway.app` |
| `network` | `"solana:devnet" \| "solana:pubnet"` | defaults to `solana:devnet` |
| `asset` | `string` | IncoToken mint pubkey (base58) |
| `recipient` | `string` | merchant pubkey (base58) |
| `cap` | `string` | total spending cap, in **whole units** (decimals from `/supported`) |
| `expirationSeconds` | `number` | session TTL, defaults to 3600 |
| `signer` | `ClientSvmSigner` | `{ publicKey, signMessage, signTransaction }` |
| `solanaRpcUrl` | `string` | optional override |

Returns a `SessionHandle`:

```ts
interface SessionHandle {
  sessionId: string;
  user: string; spender: string; asset: string; recipient: string;
  cap: string; expirationUnix: number;
  network: Network; facilitatorUrl: string;
  fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
}
```

### `wrapFetch(sessionId, facilitatorUrl)`

Returns a `fetch`-compatible function that auto-retries any `402` with `PAYMENT-REQUIRED` by attaching a `PAYMENT-SIGNATURE` header derived from the session.

### `SessionIncoScheme` (resource-server side)

Implements the `SchemeNetworkServer` interface from `@x402/core`. Use it if you're plugging into x402's resource-server framework.

---

## Troubleshooting

- **`/supported` advertises `x402Version: 2`** — the SDK won't accept anything else as the primary entry. The hosted facilitator advertises both v1 and v2 to keep client compatibility wide.
- **`Cannot convert ... to a BigInt`** when decrypting balances — the Inco Covalidator wants the encrypted handle as a **decimal u128 string**, not hex. Convert with `BigInt(\`0x${hexHandle}\`).toString()`.
- **`Address is not allowed to decrypt this handle`** — when you mint via the IncoToken program, the second `remainingAccounts` entry must be the **destination user**, not the issuer. Otherwise only the issuer can decrypt the new ciphertext.
- **Custom error 3012 (`AccountNotInitialized`)** in `transfer_with_authorization` — the merchant's IncoAccount on `TOKEN_MINT` doesn't exist yet. Bootstrap it by minting any small amount to that pubkey first (the IncoToken `create_idempotent` runs as part of `mint_to`).

---

## License

MIT.
