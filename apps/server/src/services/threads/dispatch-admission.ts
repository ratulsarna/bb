import {
  afterCommit,
  getThread,
  listActiveBackgroundTaskCountsByThreadIds,
  hasQueuedThreadMessagePluginWaits,
  type DbConnection,
  type RunningThreadRow,
} from "@bb/db";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import { listThreadsWithActiveGoals } from "./thread-runtime-display.js";
import { hasMessageDispatchHooks } from "./dispatch-hooks.js";
import { deferAfterResponse } from "../lib/response-deferral.js";

const admissions = new WeakMap<DbConnection, Map<symbol, RunningThreadRow>>();

export function reserveDispatchAdmission(
  deps: LoggedPendingInteractionWorkSessionDeps,
  row: RunningThreadRow,
): () => void {
  const { db } = deps;
  let pending = admissions.get(db);
  if (pending === undefined) {
    pending = new Map();
    admissions.set(db, pending);
  }
  const token = Symbol();
  pending.set(token, row);
  return () => {
    if (!pending.delete(token)) return;
    if (!threadOccupiesDispatchCapacity(deps, row.id))
      requestDispatchAdmissionReleased(deps);
  };
}

const releaseVersions = new WeakMap<DbConnection, number>();

export function dispatchAdmissionReleaseVersion(db: DbConnection): number {
  return releaseVersions.get(db) ?? 0;
}

export function requestDispatchAdmissionReleased(
  deps: LoggedPendingInteractionWorkSessionDeps,
): void {
  if (!hasMessageDispatchHooks(true)) return;
  releaseVersions.set(deps.db, dispatchAdmissionReleaseVersion(deps.db) + 1);
  requestAdmissionRecheck(deps);
}

export function recheckReleasedDispatchAdmission(
  deps: LoggedPendingInteractionWorkSessionDeps,
  evaluatedVersion: number,
): void {
  if (dispatchAdmissionReleaseVersion(deps.db) !== evaluatedVersion)
    requestAdmissionRecheck(deps);
}

function requestAdmissionRecheck(
  deps: LoggedPendingInteractionWorkSessionDeps,
): void {
  if (
    !hasMessageDispatchHooks(true) ||
    !hasQueuedThreadMessagePluginWaits(deps.db)
  )
    return;
  requestQueuedMessageDispatch(deps, { kind: "dispatch-admission-released" });
}

function threadOccupiesDispatchCapacity(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
): boolean {
  const thread = getThread(deps.db, threadId);
  if (thread === null) return false;
  return (
    ["starting", "active", "stopping"].includes(thread.status) ||
    listActiveBackgroundTaskCountsByThreadIds(deps.db, {
      threadIds: [threadId],
      includeSkippedTranscript: true,
    }).length > 0 ||
    listThreadsWithActiveGoals(deps, [threadId]).length > 0
  );
}

const occupancyEventTypes = new Set([
  "item/backgroundTask/completed",
  "item/backgroundTask/progress",
  "thread/goal/updated",
  "thread/goal/cleared",
  "thread/extensionState/updated",
  "system/operation",
  "system/error",
  "system/thread/interrupted",
]);

export function observeDispatchAdmissionReleases(
  deps: LoggedPendingInteractionWorkSessionDeps,
): () => void {
  let releaseCheckPending = false;
  let stopped = false;
  const scheduleReleaseCheck = () => {
    if (releaseCheckPending || stopped) return;
    releaseCheckPending = true;
    deferAfterResponse({
      config: deps.config,
      logger: deps.logger,
      name: "Dispatch admission release check",
      work: async () => {
        releaseCheckPending = false;
        if (!stopped) requestDispatchAdmissionReleased(deps);
      },
    });
  };
  const unsubscribe = deps.hub.onChangedMessage((message) => {
    if (message.entity !== "thread" || !hasMessageDispatchHooks(true)) return;
    if (
      !message.changes.some(
        (change) =>
          change === "status-changed" ||
          change === "thread-deleted" ||
          change === "history-rewritten",
      ) &&
      !message.metadata?.eventTypes?.some((type) =>
        occupancyEventTypes.has(type),
      )
    )
      return;
    afterCommit(deps.db, scheduleReleaseCheck);
  });
  return () => {
    stopped = true;
    unsubscribe();
  };
}

export function listDispatchAdmissions(db: DbConnection): RunningThreadRow[] {
  return [...(admissions.get(db)?.values() ?? [])];
}
