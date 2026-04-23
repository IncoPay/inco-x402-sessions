// Type shims so we can use @inco/solana-sdk subpath imports with moduleResolution: "node".
declare module "@inco/solana-sdk/encryption" {
  export function encryptValue(value: bigint | number | boolean): Promise<string>;
}
declare module "@inco/solana-sdk/attested-decrypt" {
  export function decrypt(
    handles: string[],
    opts: {
      address: import("@solana/web3.js").PublicKey;
      signMessage: (msg: Uint8Array) => Promise<Uint8Array>;
    }
  ): Promise<{ plaintexts: string[] }>;
}
declare module "@inco/solana-sdk/utils" {
  export function hexToBuffer(hex: string): Buffer;
}
