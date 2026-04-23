/**
 * SessionInco Scheme plugin for @x402/core resource-server integration.
 * Duck-typed to avoid hard dependency on @x402/core types (its exports map uses
 * node16 moduleResolution which breaks older tsconfigs).
 */

import { Network, PaymentRequirements, SCHEME } from "./types";

export interface SessionIncoSchemeConfig {
  /** SPL mint address of the session asset (base58). */
  mint: string;
  /** Default decimals for decimal→base-units conversion. */
  decimals?: number;
  /** Our facilitator URL — gets baked into PaymentRequirements.extra so clients can find /sessions. */
  facilitatorUrl: string;
}

export class SessionIncoScheme {
  readonly scheme = SCHEME;
  readonly mint: string;
  readonly decimals: number;
  readonly facilitatorUrl: string;

  constructor(cfg: SessionIncoSchemeConfig) {
    this.mint = cfg.mint;
    this.decimals = cfg.decimals ?? 6;
    this.facilitatorUrl = cfg.facilitatorUrl;
  }

  async parsePrice(
    price: string | { asset: string; amount: string | number },
    _network: Network
  ): Promise<{ asset: string; amount: string; extra?: Record<string, unknown> }> {
    if (typeof price === "string") {
      return {
        asset: this.mint,
        amount: decimalToBaseUnits(price, this.decimals).toString(),
      };
    }
    return {
      asset: price.asset || this.mint,
      amount:
        typeof price.amount === "number"
          ? BigInt(Math.floor(price.amount)).toString()
          : price.amount,
    };
  }

  async enhancePaymentRequirements(
    req: PaymentRequirements,
    _supportedKind: unknown,
    _facilitatorExtensions?: Record<string, unknown>
  ): Promise<PaymentRequirements> {
    return {
      ...req,
      scheme: SCHEME,
      extra: {
        ...(req.extra || {}),
        facilitatorUrl: this.facilitatorUrl,
        sessionsEndpoint: `${this.facilitatorUrl.replace(/\/$/, "")}/sessions`,
      },
    };
  }
}

// local copy (to avoid cross-module circular): same logic as solana.decimalToBaseUnits
function decimalToBaseUnits(amount: string, decimals: number): bigint {
  const [whole, frac = ""] = amount.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const s = (whole || "0") + padded;
  return BigInt(s.replace(/^0+(?=\d)/, "") || "0");
}
