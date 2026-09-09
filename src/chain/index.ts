/**
 * On-chain integration against the deployed ProofOwl registry via
 * @proofowl/contract-sdk.
 *
 * Reads (`createChainModule` / `createChainReadClient`) are read-only
 * simulations. The write path — `submitAttestation` and its
 * testnet-guarded `createSdkAttestationSubmitter` — is re-exported here
 * too (see ./submit.ts); it is the ONLY mutating call in this repo, it
 * is testnet-only, and it is not wired to any scheduler.
 */

import type { ChainConfig } from "../config.js";
import type { ProofOwlContractConfig } from "@proofowl/contract-sdk";
import { createChainReadClient, type ChainReadClient } from "./readClient.js";

export * from "./readClient.js";
export * from "./submit.js";
export * from "./attestationSubmitter.js";

export function chainConfigToSdkConfig(cfg: ChainConfig): ProofOwlContractConfig {
  return {
    contractId: cfg.contractId,
    rpcUrl: cfg.rpcUrl,
    networkPassphrase: cfg.networkPassphrase,
    allowHttp: cfg.allowHttp,
  };
}

export function createChainModule(cfg: ChainConfig): ChainReadClient {
  return createChainReadClient(chainConfigToSdkConfig(cfg));
}
