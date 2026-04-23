/**
 * Wire + session types for inco-x402-sessions.
 * Mirrored exactly in the facilitator.
 */

export type Network = "solana:devnet" | "solana:mainnet";

export interface PaymentRequirements {
  scheme: string;
  network: Network;
  asset: string;        // SPL mint (base58)
  amount: string;       // base-units amount
  payTo: string;        // recipient pubkey (base58)
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface SupportedKind {
  x402Version: 1 | 2;
  scheme: string;
  network: Network;
  asset?: string;
  extra?: Record<string, unknown>;
}

export interface SupportedResponse {
  kinds: SupportedKind[];
}

export interface PaymentRequired {
  x402Version: 1 | 2;
  error?: string;
  resource?: { url: string; description?: string; mimeType?: string };
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

/** The body the client sends in PAYMENT-SIGNATURE on retry. */
export interface SessionPaymentPayloadBody {
  sessionId: string;
  amount: string;        // base units (facilitator cross-checks vs accepted.amount)
  nonce?: string;        // optional replay-protection hex (facilitator dedupes)
}

export interface PaymentPayload {
  x402Version: 1 | 2;
  accepted: PaymentRequirements;
  payload: SessionPaymentPayloadBody;
  resource?: { url: string };
  extensions?: Record<string, unknown>;
}

// ---------- Session REST shapes ----------

export interface CreateSessionRequest {
  user: string;                 // base58 pubkey
  asset: string;                // mint pubkey
  recipient: string;            // payTo pubkey
  cap: string;                  // base units
  expirationUnix: number;       // seconds since epoch; facilitator converts to slot internally
  network: Network;
  approveTxSignature: string;   // signature of on-chain approve(ciphertext)
  authMessage: string;          // base64 of canonical JSON that user Ed25519-signed
  authSignature: string;        // base64 Ed25519 signature over authMessage
}

export interface CreateSessionResponse {
  sessionId: string;
  user: string;
  spender: string;
  asset: string;
  recipient: string;
  cap: string;
  spent: string;
  expirationUnix: number;
  network: Network;
}

export interface SessionRecord extends CreateSessionResponse {
  createdAt: number;
}

export interface VerifyRequest {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
}

export interface SettleRequest extends VerifyRequest {}

export interface SettleResponse {
  success: boolean;
  transaction: string;   // base58 tx signature or ""
  network: Network;
  payer?: string;
  errorReason?: string;
  errorMessage?: string;
  extensions?: Record<string, unknown>;
}

// ---------- Client signer abstraction ----------

/**
 * A Solana signer the SDK can use. Two flavors:
 * - Node/keypair: expose `publicKey` + `signMessage` + `signTransaction`
 * - Browser wallet adapter: same surface, but signTransaction comes from wallet
 */
export interface ClientSvmSigner {
  publicKey: string;   // base58
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  signTransaction(txBase64: string): Promise<string>;   // returns base64 signed tx
}

export interface SessionHandle {
  sessionId: string;
  user: string;
  spender: string;
  asset: string;
  recipient: string;
  cap: string;
  expirationUnix: number;
  network: Network;
  facilitatorUrl: string;
  fetch: typeof fetch;
}

export interface CreateSessionOptions {
  facilitatorUrl: string;
  network: Network;
  asset: string;              // mint pubkey (base58)
  recipient: string;          // payTo pubkey
  cap: string;                // decimal string, e.g. "5" for 5 pUSDC
  expirationSeconds: number;  // e.g. 3600
  signer: ClientSvmSigner;
  decimals?: number;          // defaults to 6
  solanaRpcUrl?: string;      // defaults to https://api.devnet.solana.com for devnet
}

export const SCHEME = "session";
