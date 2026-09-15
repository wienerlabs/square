// The two calls of snarkjs this package makes. snarkjs ships no types.
declare module "snarkjs" {
  export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  }
  export const groth16: {
    fullProve(input: Record<string, unknown>, wasmFile: string, zkeyFileName: string): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    verify(verificationKey: unknown, publicSignals: readonly string[], proof: Groth16Proof): Promise<boolean>;
  };
}
