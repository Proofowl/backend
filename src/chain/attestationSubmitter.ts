/**
 * The real {@link AttestationSubmitter}: assembles, simulates, signs
 * (with `ATTESTOR_SECRET_KEY`), and submits `submit_attestation` against
 * a **testnet** ProofOwl instance.
 *
 * It is a thin adapter over `@proofowl/contract-sdk`'s
 * `prepareSubmitAttestation` (which builds and simulates the call
 * through the SDK's generated contract client — this file assembles
 * nothing by hand) plus `@stellar/stellar-sdk`'s `basicNodeSigner` for
 * the signature. All orchestration — the short-circuits, the failure
 * taxonomy, the dry-run gate — lives in {@link submitAttestation}; this
 * file only turns "an assembled+simulated tx" into the neutral
 * {@link PreparedAttestationTx} shape and maps the network's send result
 * onto {@link SentAttestationOutcome}.
 *
 * Two invariants enforced in the constructor, not just documented:
 *  - the config's network passphrase must be the confirmed Stellar
 *    **testnet** passphrase (mainnet is refused by name; anything else
 *    is refused as unconfirmed) — see {@link assertTestnet};
 *  - `ATTESTOR_SECRET_KEY` is parsed once here and NEVER echoed — not in
 *    an error message, not in a log line. A malformed value yields a
 *    fixed string that does not contain the input.
 */

import { Keypair, rpc } from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { prepareSubmitAttestation, type ProofOwlContractConfig } from "@proofowl/contract-sdk";

import { UpstreamError, ValidationError } from "../lib/errors.js";
import {
  assertTestnet,
  type AttestationSubmitter,
  type PreparedAttestationTx,
  type SentAttestationOutcome,
} from "./submit.js";

const STRKEY_G_RE = /^G[A-Z2-7]{55}$/;

/**
 * Build the production submitter for `config` (must be testnet) signing
 * as `attestorSecretKey`. Throws before any network use if the network
 * is not confirmed testnet or the secret key is malformed.
 */
export function createSdkAttestationSubmitter(
  config: ProofOwlContractConfig,
  attestorSecretKey: string,
): AttestationSubmitter {
  assertTestnet(config.networkPassphrase);

  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(attestorSecretKey);
  } catch {
    // Deliberately fixed — the invalid value must not reach a log.
    throw new ValidationError("ATTESTOR_SECRET_KEY is not a valid Stellar secret key");
  }
  const attestor = keypair.publicKey();
  const { signTransaction } = basicNodeSigner(keypair, config.networkPassphrase);

  return {
    network: config.networkPassphrase,

    async prepare(input): Promise<PreparedAttestationTx> {
      const tx = await prepareSubmitAttestation(config, {
        attestor,
        githubIdHash: input.githubIdHash,
        repo: input.repo,
        prNumber: input.prNumber,
        issueId: input.issueId,
        complexity: input.complexity,
        prHash: input.prHash,
      });

      const sim = tx.simulation;
      if (!sim) {
        throw new UpstreamError("submit_attestation was assembled without a simulation");
      }

      if (rpc.Api.isSimulationError(sim)) {
        const simulationError = sim.error;
        return {
          simulationError,
          simulatedCreditWallet: null,
          minResourceFee: null,
          send() {
            // The orchestrator never calls send() after a simulation
            // error, but make the boundary impossible to misuse.
            return Promise.reject(
              new UpstreamError(
                `refusing to send: submit_attestation simulation failed: ${simulationError}`,
              ),
            );
          },
        };
      }

      return {
        simulationError: null,
        simulatedCreditWallet: safeDecodeWallet(readResult(tx)),
        minResourceFee: sim.minResourceFee,
        send: () => sendPrepared(tx, signTransaction),
      };
    },
  };
}

// --- send-result mapping ------------------------------------------------

interface SendResp {
  status?: string;
  hash?: string;
  errorResultXdr?: string;
}
interface GetResp {
  status?: string;
  txHash?: string;
  ledger?: number;
}

async function sendPrepared(
  tx: AssembledTransaction<unknown>,
  signTransaction: ReturnType<typeof basicNodeSigner>["signTransaction"],
): Promise<SentAttestationOutcome> {
  const sent = await tx.signAndSend({ signTransaction });
  const sendResp = sent.sendTransactionResponse as SendResp | undefined;
  const getResp = sent.getTransactionResponse as GetResp | undefined;
  const txHash = sendResp?.hash ?? getResp?.txHash ?? null;

  if (sendResp?.status === "ERROR") {
    return {
      status: "ERROR",
      txHash,
      ledger: null,
      creditedWallet: null,
      detail:
        "rejected at submission" +
        (sendResp.errorResultXdr ? ` (errorResultXdr: ${sendResp.errorResultXdr})` : ""),
    };
  }

  if (getResp?.status === "SUCCESS") {
    return {
      status: "SUCCESS",
      txHash,
      ledger: typeof getResp.ledger === "number" ? getResp.ledger : null,
      creditedWallet: safeDecodeWallet(readSentResult(sent)),
      detail: null,
    };
  }

  if (getResp?.status === "FAILED") {
    return {
      status: "FAILED",
      txHash,
      ledger: typeof getResp.ledger === "number" ? getResp.ledger : null,
      creditedWallet: null,
      detail: "transaction failed after inclusion",
    };
  }

  return {
    status: (getResp?.status as SentAttestationOutcome["status"]) ?? "PENDING",
    txHash,
    ledger: null,
    creditedWallet: null,
    detail: "transaction not confirmed within the client wait window",
  };
}

// --- return-value decoding -------------------------------------------

function readResult(tx: AssembledTransaction<unknown>): unknown {
  try {
    return tx.result;
  } catch {
    return null;
  }
}

function readSentResult(sent: { result?: unknown }): unknown {
  try {
    return sent.result;
  } catch {
    return null;
  }
}

/** `submit_attestation` returns the credited wallet as `Result<string>`; be lenient about the wrapper. */
function safeDecodeWallet(r: unknown): string | null {
  if (typeof r === "string") return STRKEY_G_RE.test(r) ? r : null;
  if (r && typeof r === "object") {
    const o = r as { unwrap?: () => unknown; value?: unknown };
    if (typeof o.unwrap === "function") {
      try {
        const v = o.unwrap();
        return typeof v === "string" && STRKEY_G_RE.test(v) ? v : null;
      } catch {
        return null;
      }
    }
    if (typeof o.value === "string") return STRKEY_G_RE.test(o.value) ? o.value : null;
  }
  return null;
}
