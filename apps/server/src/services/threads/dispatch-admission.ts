import {
  getThread,
  listQueuedThreadMessagePluginWaitRefs,
  type DbConnection,
  type RunningThreadRow,
} from "@bb/db";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import { hasMessageDispatchHooks } from "./dispatch-hooks.js";

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
    const status = getThread(db, row.id)?.status;
    if (
      status !== "starting" &&
      status !== "active" &&
      status !== "stopping"
    ) {
      requestDispatchAdmissionReleased(deps);
    }
  };
}

export function requestDispatchAdmissionReleased(
  deps: LoggedPendingInteractionWorkSessionDeps,
): void {
  if (
    !hasMessageDispatchHooks(true) ||
    listQueuedThreadMessagePluginWaitRefs(deps.db).length === 0
  )
    return;
  requestQueuedMessageDispatch(deps, {
    kind: "dispatch-admission-released",
  });
}

export function listDispatchAdmissions(db: DbConnection): RunningThreadRow[] {
  return [...(admissions.get(db)?.values() ?? [])];
}
