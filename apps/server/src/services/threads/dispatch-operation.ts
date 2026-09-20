import type { Thread, ThreadTurnInitiator } from "@bb/domain";
import type { SendMessageRequest } from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { requirePublicProject } from "../lib/entity-lookup.js";
import { reserveDispatchAdmission } from "./dispatch-admission.js";
import {
  dispatchEnvironmentAndHost,
  dispatchExecutionSources,
  dispatchWaitReasonForPass,
  hasMessageDispatchHooks,
  resolveDispatchAttemptKind,
  runMessageDispatchHookPass,
  type MessageDispatchHookPassOutcome,
} from "./dispatch-hooks.js";
import { buildExecutionOptions } from "./thread-commands.js";
import { toThreadResponseFromThread } from "./thread-runtime-display.js";

export class StrictDispatchWaitError extends ApiError {
  constructor(
    readonly outcome: Extract<MessageDispatchHookPassOutcome, { kind: "wait" }>,
  ) {
    super(409, "dispatch_rejected", dispatchWaitReasonForPass(outcome), {
      details: { pluginId: outcome.waiter.pluginId },
    });
  }
}

export async function withStrictDispatchAdmission<T>(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    thread: Thread;
    payload: SendMessageRequest;
    initiator?: ThreadTurnInitiator;
  },
  run: () => Promise<T>,
): Promise<T> {
  if (!hasMessageDispatchHooks(true)) return run();
  const { thread, payload } = args;
  const execution = await buildExecutionOptions(deps, payload, {
    threadId: thread.id,
  });
  let release: (() => void) | undefined;
  try {
    const outcome = await runMessageDispatchHookPass(deps, {
      strictOnly: true,
      thread,
      threadResponse: toThreadResponseFromThread(deps, { thread }),
      project: requirePublicProject(deps.db, thread.projectId),
      environmentId: thread.environmentId,
      intendedHostId: null,
      environmentIntent: null,
      input: payload.input,
      requestedExecution: { providerId: thread.providerId, ...execution },
      executionSources: dispatchExecutionSources(
        payload.executionInputSources ?? {},
      ),
      attempt: resolveDispatchAttemptKind(thread, payload.mode),
      initiator: args.initiator ?? (payload.senderThreadId ? "agent" : "user"),
      senderThreadId: payload.senderThreadId ?? null,
      origin: null,
      originPluginId: null,
      startedOnBehalfOf: null,
      parentThreadId: thread.parentThreadId,
      queuedMessages: [],
      pluginSubmission: null,
      continueAfterHooks: async () => {
        release = reserveDispatchAdmission(deps, {
          id: thread.id,
          hostId:
            dispatchEnvironmentAndHost(deps, thread.environmentId).host?.id ??
            null,
        });
      },
    });
    if (outcome.kind === "wait") {
      throw new StrictDispatchWaitError(outcome);
    }
    return await run();
  } finally {
    release?.();
  }
}
