/**
 * On-chain read integration. Read-only simulations against the deployed
 * ProofOwl registry via @proofowl/contract-sdk. No mutating calls.
 */

import type { ChainConfig } from "../config.js";
import type { ProofOwlContractConfig } from "@proofowl/contract-sdk";
import { createChainReadClient, type ChainReadClient } from "./readClient.js";

export * from "./attestationDecode.js";
export * from "./readClient.js";

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
