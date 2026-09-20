import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import {
  archiveThread,
  getThread,
  markThreadDeleted,
  getLatestThreadSequence,
} from "@bb/db";
import { requestThreadStorageDeletion } from "../../src/services/threads/thread-lifecycle.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  reportQueuedCommandSuccess,
  reportQueuedCommandError,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { threadRunningResponseSchema } from "@bb/server-contract";
import { threadScope, LEGACY_CODEX_GOAL_EXTENSION_KIND } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedStoredEvent,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

async function running(harness: TestAppHarness, strict = false) {
  const response = await harness.app.request(
    `/api/v1/threads/running${strict ? "?experimental_includeDispatchOccupancy=true" : ""}`,
  );
  expect(response.status).toBe(200);
  return threadRunningResponseSchema.parse(await readJson(response));
}

describe("GET /threads/running", () => {
  it("returns every occupying thread as an id and the host it occupies", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-running",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-running-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-running-source",
      });
      const root = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "active",
      });
      const child = seedThread(harness.deps, {
        environmentId: environment.id,
        parentThreadId: root.id,
        projectId: project.id,
        status: "active",
      });
      const spawned = seedThread(harness.deps, {
        environmentId: environment.id,
        originPluginId: "workflows",
        projectId: project.id,
        status: "active",
      });
      // Admitted but not yet provisioned: on no host, still occupying.
      const unplaced = seedThread(harness.deps, {
        environmentId: null,
        projectId: project.id,
        status: "starting",
      });
      // Neither of these occupies anything.
      seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });
      const archived = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "active",
      });
      archiveThread(harness.db, harness.deps.hub, archived.id);

      const rows = await running(harness);
      // A child and a plugin-spawned thread occupy slots like any other, so
      // the route reports them.
      expect(new Set(rows.map((row) => row.id))).toEqual(
        new Set([root.id, child.id, spawned.id, unplaced.id]),
      );
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(root.id)).toEqual({ id: root.id, hostId: host.id });
      expect(byId.get(unplaced.id)?.hostId).toBeNull();
    });
  });
});

it("includes stopping and unfinished tracked work even after archival, then releases completed work", async () => {
  await withTestHarness(async (harness) => {
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
    });
    const stopping = seedThread(harness.deps, {
      environmentId: environment.id,
      projectId: project.id,
      status: "stopping",
    });
    const plainPending = seedThread(harness.deps, {
      environmentId: environment.id,
      projectId: project.id,
      status: "pending",
    });
    const tasks = [
      { taskType: "local_bash", skipTranscript: false },
      { taskType: "local_agent", skipTranscript: false },
      { taskType: "local_subagent", skipTranscript: false },
      { taskType: "local_workflow", skipTranscript: false },
      { taskType: "local_workflow", skipTranscript: true },
    ].map(({ taskType, skipTranscript }, index) => {
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: index === 0 ? "pending" : "idle",
      });
      const item = {
        type: "backgroundTask",
        id: `task-${index}`,
        taskType,
        status: "pending",
        taskStatus: "running",
        description: "Working",
        skipTranscript,
      };
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 1,
        type: "item/started",
        scope: threadScope(),
        itemId: item.id,
        itemKind: "backgroundTask",
        data: { item },
      });
      return { thread, item };
    });
    archiveThread(harness.db, harness.hub, tasks[1]!.thread.id);
    expect(
      getThread(harness.db, tasks[1]!.thread.id)?.archivedAt,
    ).not.toBeNull();
    expect(await running(harness)).toEqual([]);
    expect(
      new Set((await running(harness, true)).map((row) => row.id)),
    ).toEqual(new Set([stopping.id, ...tasks.map(({ thread }) => thread.id)]));
    expect(
      (await running(harness, true)).some((row) => row.id === plainPending.id),
    ).toBe(false);
    for (const { thread, item } of tasks) {
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 2,
        type: "item/backgroundTask/completed",
        scope: threadScope(),
        itemId: item.id,
        itemKind: "backgroundTask",
        data: {
          item: { ...item, status: "completed", taskStatus: "completed" },
        },
      });
    }
    expect(await running(harness, true)).toEqual([
      { id: stopping.id, hostId: host.id },
    ]);
  });
});

it("keeps archived and deleted live runtimes occupied until stop settles", async () => {
  await withTestHarness(async (harness) => {
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
    });
    const threads = ["starting", "active"].map((status) =>
      seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: status === "starting" ? "starting" : "active",
      }),
    );
    archiveThread(harness.db, harness.hub, threads[0]!.id);
    markThreadDeleted(harness.db, harness.hub, { threadId: threads[1]!.id });
    expect(await running(harness)).toEqual([]);
    expect(
      new Set((await running(harness, true)).map((row) => row.id)),
    ).toEqual(new Set(threads.map((thread) => thread.id)));
    for (const thread of threads) {
      applyLoggedThreadLifecycleEvent(harness.deps, {
        threadId: thread.id,
        event: { type: "stop.requested" },
      });
    }
    expect(await running(harness, true)).toHaveLength(2);
    for (const thread of threads) {
      applyLoggedThreadLifecycleEvent(harness.deps, {
        threadId: thread.id,
        event: { type: "stop.settled" },
      });
    }
    expect(await running(harness, true)).toEqual([]);
  });
});

it.each([
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
  null,
] as const)(
  "holds active native goals between turns and releases on %s",
  async (status) => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });
      const goal = {
        objective: "Work",
        status: "active",
        tokenBudget: 10_000,
        tokensUsed: 100,
        timeUsedSeconds: 1,
      };
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 1,
        type: "thread/extensionState/updated",
        providerThreadId: "provider-goal",
        scope: threadScope(),
        data: { kind: LEGACY_CODEX_GOAL_EXTENSION_KIND, payload: goal },
      });
      expect(await running(harness)).toEqual([]);
      expect(await running(harness, true)).toEqual([
        { id: thread.id, hostId: host.id },
      ]);
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 2,
        type: "thread/extensionState/updated",
        providerThreadId: "provider-goal",
        scope: threadScope(),
        data: {
          kind: LEGACY_CODEX_GOAL_EXTENSION_KIND,
          payload: status === null ? null : { ...goal, status },
        },
      });
      expect(await running(harness, true)).toEqual([]);
    });
  },
);

function seedIdleGoal(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: "provider-goal",
    threadId: thread.id,
  });
  seedStoredEvent(harness.deps, {
    threadId: thread.id,
    sequence: getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
    type: "thread/extensionState/updated",
    providerThreadId: "provider-goal",
    scope: threadScope(),
    data: {
      kind: LEGACY_CODEX_GOAL_EXTENSION_KIND,
      payload: {
        objective: "Work",
        status: "active",
        tokenBudget: 10_000,
        tokensUsed: 100,
        timeUsedSeconds: 1,
      },
    },
  });
  return { thread, environment, host };
}

it("holds an idle active goal until Stop confirms and counts it again after an admitted restart", async () => {
  await withTestHarness(async (harness) => {
    const { thread, host } = seedIdleGoal(harness);
    const expected = [{ id: thread.id, hostId: host.id }];
    expect(await running(harness, true)).toEqual(expected);
    const stopResponse = harness.app.request(
      `/api/v1/threads/${thread.id}/stop`,
      { method: "POST" },
    );
    const stop = await waitForQueuedCommand(
      harness,
      ({ command }) =>
        command.type === "thread.stop" && command.threadId === thread.id,
    );
    expect(await running(harness, true)).toEqual(expected);
    await reportQueuedCommandSuccess(harness, stop, {
      providerCheckpointId: null,
    });
    expect((await stopResponse).status).toBe(200);
    expect(await running(harness, true)).toEqual([]);
    await acceptThreadSendRequest(harness.deps, {
      thread: getThread(harness.db, thread.id)!,
      payload: {
        input: textInput("Later"),
        mode: "auto",
        sendAt: Date.now() + 60_000,
      },
    });
    expect(await running(harness, true)).toEqual([]);
    await acceptThreadSendRequest(harness.deps, {
      thread: getThread(harness.db, thread.id)!,
      payload: { input: textInput("Restart"), mode: "auto" },
    });
    expect(await running(harness, true)).toEqual(expected);
    applyLoggedThreadLifecycleEvent(harness.deps, {
      threadId: thread.id,
      event: { type: "run.succeeded" },
    });
    expect(getThread(harness.db, thread.id)?.status).toBe("idle");
    expect(await running(harness, true)).toEqual(expected);
  });
});

it("keeps a deleted idle goal occupied through failed storage deletion and releases after confirmation", async () => {
  await withTestHarness(async (harness) => {
    const { thread, environment, host } = seedIdleGoal(harness);
    markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });
    const expected = [{ id: thread.id, hostId: host.id }];
    expect(await running(harness, true)).toEqual(expected);
    requestThreadStorageDeletion(harness.deps, thread, environment);
    const failed = await waitForQueuedCommand(
      harness,
      ({ command }) =>
        command.type === "thread.storage.delete" &&
        command.threadId === thread.id,
    );
    await reportQueuedCommandError(harness, failed, {
      errorCode: "cleanup_failed",
      errorMessage: "Failed to stop",
    });
    expect(await running(harness, true)).toEqual(expected);
    requestThreadStorageDeletion(harness.deps, thread, environment);
    const success = await waitForQueuedCommand(
      harness,
      ({ command }) =>
        command.type === "thread.storage.delete" &&
        command.threadId === thread.id,
    );
    expect(await running(harness, true)).toEqual(expected);
    await reportQueuedCommandSuccess(harness, success, {
      providerCheckpointId: null,
    });
    expect(await running(harness, true)).toEqual([]);
  });
});
