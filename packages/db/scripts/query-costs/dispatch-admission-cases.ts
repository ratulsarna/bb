import {
  LEGACY_CODEX_GOAL_EXTENSION_KIND,
  LOCAL_BASH_TASK_TYPE,
  THREAD_RUNTIME_STOPPED_OPERATION,
  threadScope,
  turnScope,
} from "@bb/domain";
import {
  appendStoredThreadEventsInTransaction,
  listActiveBackgroundTaskCountsByThreadIds,
  listLatestThreadStateEventRowsByThreadIds,
  listThreadDispatchOccupancy,
  type AppendStoredThreadEventArgs,
} from "../../src/data/events.js";
import { createThread } from "../../src/data/threads.js";
import { noopNotifier } from "../../src/notifier.js";
import { registerCostGroup, scaled } from "./case.js";

const EVENTS = "packages/db/src/data/events.ts";

export const DISPATCH_ADMISSION_COST_GROUP = registerCostGroup({
  name: "dispatch-admission",
  seed: (db, fixture, scale) => {
    const thread = createThread(db, noopNotifier, {
      projectId: fixture.projectId,
      environmentId: fixture.environmentId,
      providerId: "test",
      status: "idle",
    });
    const cycles = scaled(10_000, scale);
    for (let offset = 0; offset < cycles; offset += 250) {
      const rows: AppendStoredThreadEventArgs[] = [];
      for (
        let index = offset;
        index < Math.min(offset + 250, cycles);
        index += 1
      ) {
        const turnId = `dispatch-${index}`;
        const base = {
          threadId: thread.id,
          providerThreadId: fixture.providerThreadId,
        };
        const task = {
          id: `dispatch-task-${index}`,
          type: "backgroundTask" as const,
          taskType: LOCAL_BASH_TASK_TYPE,
          description: "Run checks",
          foreground: false,
          skipTranscript: true,
        };
        rows.push(
          {
            ...base,
            scope: threadScope(),
            type: "thread/extensionState/updated",
            data: {
              providerThreadId: fixture.providerThreadId,
              kind: LEGACY_CODEX_GOAL_EXTENSION_KIND,
              payload: {
                objective: "Finish the task",
                status: "active",
                tokenBudget: null,
                tokensUsed: index,
                timeUsedSeconds: index,
              },
            },
          },
          {
            ...base,
            scope: threadScope(),
            type: "system/operation",
            data: {
              operation: THREAD_RUNTIME_STOPPED_OPERATION,
              operationId: `dispatch-stop-${index}`,
              status: "completed",
              message: "Thread stopped",
            },
          },
          {
            ...base,
            scope: turnScope(turnId),
            type: "turn/started",
            data: { providerThreadId: fixture.providerThreadId },
          },
          {
            ...base,
            scope: turnScope(turnId),
            type: "item/started",
            data: {
              providerThreadId: fixture.providerThreadId,
              item: { ...task, status: "pending", taskStatus: "running" },
            },
          },
        );
        if (index < cycles - 1) {
          rows.push({
            ...base,
            scope: turnScope(turnId),
            type: "item/backgroundTask/completed",
            data: {
              providerThreadId: fixture.providerThreadId,
              item: { ...task, status: "completed", taskStatus: "completed" },
            },
          });
        }
      }
      db.transaction((tx) => appendStoredThreadEventsInTransaction(tx, rows));
    }
    return { threadId: thread.id };
  },
  cases: [
    {
      name: `${EVENTS}#listThreadDispatchOccupancy`,
      variant: "all threads with repeated goal stops and tracked tasks",
      run: (db) =>
        listThreadDispatchOccupancy(db, {
          goalStateKind: LEGACY_CODEX_GOAL_EXTENSION_KIND,
        }),
    },
    {
      name: `${EVENTS}#listThreadDispatchOccupancy`,
      variant: "release check for one thread",
      run: (db, _fixture, seed) =>
        listThreadDispatchOccupancy(db, {
          goalStateKind: LEGACY_CODEX_GOAL_EXTENSION_KIND,
          threadIds: [seed.threadId],
        }),
    },
    {
      name: `${EVENTS}#listLatestThreadStateEventRowsByThreadIds`,
      variant: "active goals across all threads",
      run: (db) =>
        listLatestThreadStateEventRowsByThreadIds(db, {
          kind: LEGACY_CODEX_GOAL_EXTENSION_KIND,
          status: "active",
          excludeStopped: true,
        }),
    },
    {
      name: `${EVENTS}#listLatestThreadStateEventRowsByThreadIds`,
      variant: "confirmed runtime stop check",
      run: (db, _fixture, seed) =>
        listLatestThreadStateEventRowsByThreadIds(db, {
          kind: LEGACY_CODEX_GOAL_EXTENSION_KIND,
          threadIds: [seed.threadId],
          status: "active",
          excludeStopped: true,
        }),
    },
    {
      name: `${EVENTS}#listLatestThreadStateEventRowsByThreadIds`,
      variant: "latest active goal without runtime filter",
      run: (db, _fixture, seed) =>
        listLatestThreadStateEventRowsByThreadIds(db, {
          kind: LEGACY_CODEX_GOAL_EXTENSION_KIND,
          threadIds: [seed.threadId],
          status: "active",
        }),
    },
    {
      name: `${EVENTS}#listActiveBackgroundTaskCountsByThreadIds`,
      variant: "all threads including skipped transcript tasks",
      run: (db) =>
        listActiveBackgroundTaskCountsByThreadIds(db, {
          includeSkippedTranscript: true,
        }),
    },
  ],
});
