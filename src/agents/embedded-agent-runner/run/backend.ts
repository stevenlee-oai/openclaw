/** Dispatches embedded attempts to native harness or OpenClaw backend execution. */
import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import {
  runAgentHarnessAttempt,
  runAgentHarnessSettledTurnFinalization,
} from "../../harness/selection.js";
import type { AgentHarness } from "../../harness/types.js";
import { formatModelEndpointUrl } from "../../model-endpoint.js";
import type { AgentRuntimeModelAttempt, AgentRuntimePlan } from "../../runtime-plan/types.js";
import {
  markRequesterTurnYielded,
  settleRequesterAfterSessionSpawns,
} from "../../subagents/registry/subagent-registry.js";
import { copyCoreTtsAttemptResultProvenance } from "../../tools/tts-tool-result-provenance.js";
import { shouldContinueInteractiveAcceptedSessionSpawns } from "./attempt-terminal-evidence.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

type ModelRequestObserver = (
  request: NonNullable<EmbeddedRunAttemptResult["lastModelRequest"]>,
) => void;

/** Replaces backend-retained provenance with the exact prepared request fact. */
export function resolveRuntimeModelAttempt(
  runtimePlan: AgentRuntimePlan | undefined,
): AgentRuntimeModelAttempt | undefined {
  const credentialSource = runtimePlan?.auth.credentialSource;
  return credentialSource
    ? {
        provider: runtimePlan.resolvedRef.provider,
        model: runtimePlan.resolvedRef.modelId,
        credentialSource,
      }
    : undefined;
}

async function observeAttemptRequests<T>(
  params: EmbeddedRunAttemptParams,
  run: (params: EmbeddedRunAttemptParams) => Promise<T>,
  onObserved?: ModelRequestObserver,
) {
  let lastModelRequest: EmbeddedRunAttemptResult["lastModelRequest"];
  let observing = true;
  try {
    const result = await run({
      ...params,
      onModelRequest: (request) => {
        if (!observing) {
          return;
        }
        // Diagnostic failure cannot turn a valid model request into an inference failure.
        try {
          const endpoint = formatModelEndpointUrl(request.url);
          if (!endpoint) {
            return;
          }
          lastModelRequest = {
            provider: params.provider,
            model: sanitizeForLog(request.model ?? params.model.id).slice(0, 256),
            endpoint,
            transport: request.transport,
            timestamp: Date.now(),
          };
          onObserved?.(lastModelRequest);
        } catch {}
      },
    });
    return { result, lastModelRequest };
  } finally {
    // Retained transport callbacks cannot rewrite a settled attempt's observation.
    observing = false;
  }
}

/** Backend bridge for one attempt; request observations survive a thrown harness via onObserved. */
export async function runEmbeddedAttemptWithBackend(
  params: EmbeddedRunAttemptParams,
  nativeSessionRuntime?: Parameters<typeof runAgentHarnessAttempt>[1],
  onObserved?: ModelRequestObserver,
): Promise<EmbeddedRunAttemptResult> {
  const { result, lastModelRequest } = await observeAttemptRequests(
    params,
    (attempt) => runAgentHarnessAttempt(attempt, nativeSessionRuntime),
    onObserved,
  );
  // Native harness fields cannot attest core registry settlement. The built-in
  // runner has already settled at its own attempt boundary.
  let requesterContinuationSettled =
    result.agentHarnessId === "openclaw" && result.requesterContinuationSettled === true;
  if (
    result.agentHarnessId !== "openclaw" &&
    params.sessionKey &&
    result.acceptedSessionSpawns?.length
  ) {
    const implicitContinuation = shouldContinueInteractiveAcceptedSessionSpawns({
      attempt: result,
      run: params,
    });
    if (implicitContinuation) {
      const marked = markRequesterTurnYielded({
        requesterSessionKey: params.sessionKey,
        requesterAgentId: params.agentId,
        requesterTurnRunId: params.runId,
      });
      if (marked === 0) {
        throw new Error("accepted continuation children were not durably registered");
      }
    } else {
      const settled = settleRequesterAfterSessionSpawns({
        requesterSessionKey: params.sessionKey,
        requesterAgentId: params.agentId,
        requesterTurnRunId: params.runId,
        requesterYielded: result.yieldDetected === true,
        acceptedSessionSpawns: result.acceptedSessionSpawns,
      });
      requesterContinuationSettled = result.yieldDetected === true && settled;
    }
  }
  const {
    modelAttempt: _backendModelAttempt,
    lastModelRequest: _backendLastModelRequest,
    runtimeModelSelection,
    requesterContinuationSettled: _backendContinuationSettled,
    ...attempt
  } = result;
  const modelAttempt = resolveRuntimeModelAttempt(params.runtimePlan);
  return copyCoreTtsAttemptResultProvenance(result, {
    ...attempt,
    ...(requesterContinuationSettled ? { requesterContinuationSettled: true as const } : {}),
    ...(modelAttempt ? { modelAttempt } : {}),
    ...(lastModelRequest ? { lastModelRequest } : {}),
    // Only private prepared ownership permits a runtime to select the session model.
    ...(nativeSessionRuntime && runtimeModelSelection
      ? {
          runtimeModelSelection: {
            provider: runtimeModelSelection.provider,
            model: runtimeModelSelection.model,
          },
        }
      : {}),
  });
}

/** Runs one operation-specific settled-turn finalization through the selected harness. */
export async function runEmbeddedSettledTurnFinalizationWithBackend(
  params: EmbeddedRunAttemptParams,
  settledAttempt: EmbeddedRunAttemptResult,
  harness: AgentHarness,
  onObserved?: ModelRequestObserver,
) {
  const { result, lastModelRequest } = await observeAttemptRequests(
    params,
    (attempt) => runAgentHarnessSettledTurnFinalization(attempt, settledAttempt, harness),
    onObserved,
  );
  return { ...result, lastModelRequest };
}
