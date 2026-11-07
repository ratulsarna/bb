import {
  afterCommit,
  listThreadDispatchOccupancy,
  hasQueuedThreadMessagePluginWaits,
  type DbConnection,
  type RunningThreadRow,
} from "@bb/db";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { LEGACY_CODEX_GOAL_EXTENSION_KIND } from "@bb/domain";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
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
    if (threadsReleasedDispatchCapacity(deps, [row.id]))
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

function threadsReleasedDispatchCapacity(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadIds: readonly string[],
): boolean {
  const occupied = new Set(
    listDispatchOccupancy(deps.db, threadIds).map((row) => row.id),
  );
  return threadIds.some((id) => !occupied.has(id));
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
  const notifiedThreadIds = new Set<string>();
  const scheduleReleaseCheck = (threadId: string) => {
    if (stopped) return;
    notifiedThreadIds.add(threadId);
    if (releaseCheckPending) return;
    releaseCheckPending = true;
    deferAfterResponse({
      config: deps.config,
      logger: deps.logger,
      name: "Dispatch admission release check",
      work: async () => {
        releaseCheckPending = false;
        const threadIds = [...notifiedThreadIds];
        notifiedThreadIds.clear();
        if (!stopped && threadsReleasedDispatchCapacity(deps, threadIds))
          requestDispatchAdmissionReleased(deps);
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
    afterCommit(deps.db, () => scheduleReleaseCheck(message.id));
  });
  return () => {
    stopped = true;
    notifiedThreadIds.clear();
    unsubscribe();
  };
}

export function listDispatchOccupancy(
  db: DbConnection,
  threadIds?: readonly string[],
): RunningThreadRow[] {
  const rows = listThreadDispatchOccupancy(db, {
    ...(threadIds === undefined ? {} : { threadIds }),
    goalStateKind: LEGACY_CODEX_GOAL_EXTENSION_KIND,
  });
  const occupied = new Map(rows.map((row) => [row.id, row]));
  const requested = threadIds === undefined ? null : new Set(threadIds);
  for (const row of admissions.get(db)?.values() ?? []) {
    if (requested === null || requested.has(row.id)) occupied.set(row.id, row);
  }
  return [...occupied.values()];
}
