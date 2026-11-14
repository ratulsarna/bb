import {
  getLatestThreadSequence,
  getProject,
  getThread,
  listQueuedThreadMessages,
  listSweepItemFailures,
  markThreadDeleted,
  markThreadStorageDeleted,
  requestThreadPurge,
  threads,
} from "@bb/db";
import { threadScope } from "@bb/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { setPluginHookProvider } from "../../src/services/plugins/plugin-hook-registry.js";
import {
  advanceProjectDeletion,
  beginProjectDeletion,
} from "../../src/services/projects/project-deletion.js";
import { listRunningThreadsWithIntendedHosts } from "../../src/services/threads/dispatch-attempt.js";
import { noteDispatchRequeued } from "../../src/services/threads/dispatch-hooks.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import { reconcileDaemonReportedThreads } from "../../src/services/threads/thread-lifecycle.js";
import {
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  installAdmissionHooks,
  seedDispatchGoal,
  seedDispatchThread,
} from "../helpers/dispatch-admission.js";
import { textInput } from "../helpers/prompt-input.js";
import { seedStoredEvent } from "../helpers/seed.js";
import { runThreadPurges } from "../helpers/thread-purges.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

afterEach(() => setPluginHookProvider(undefined));

async function queueCapacityWaiter(
  harness: TestAppHarness,
  occupiedId: string,
) {
  const { thread } = seedDispatchThread(harness, { hostId: "waiting" });
  installAdmissionHooks([
    {
      pluginId: "capacity",
      experimental_enforcement: "strict",
      handler: () =>
        listRunningThreadsWithIntendedHosts(harness.deps, true).some(
          (row) => row.id === occupiedId,
        )
          ? { action: "wait", reason: "Full" }
          : { action: "proceed" },
    },
  ]);
  await expect(
    acceptThreadSendRequest(harness.deps, {
      thread,
      payload: { input: textInput("Waiting work"), mode: "auto" },
    }),
  ).resolves.toMatchObject({ delivery: "queued" });
  noteDispatchRequeued(thread.id);
  return thread;
}

it("retains a deleted project's goal slot through failed storage cleanup and wakes its waiter after confirmation", async () => {
  await withTestHarness(async (harness) => {
    const occupied = seedDispatchThread(harness, { hostId: "deleted-project" });
    seedDispatchGoal(harness, occupied);
    const waiter = await queueCapacityWaiter(harness, occupied.thread.id);

    beginProjectDeletion(harness.deps, { projectId: occupied.project.id });
    const deletion = await waitForQueuedCommand(
      harness,
      ({ command }) =>
        command.type === "thread.storage.delete" &&
        command.threadId === occupied.thread.id,
    );
    await reportQueuedCommandError(harness, deletion, {
      errorCode: "temporary_failure",
      errorMessage: "Storage unavailable",
    });
    expect(getProject(harness.db, occupied.project.id)?.deletedAt).toEqual(
      expect.any(Number),
    );
    expect(
      listRunningThreadsWithIntendedHosts(harness.deps, true),
    ).toContainEqual({ id: occupied.thread.id, hostId: occupied.host.id });
    expect(getThread(harness.db, waiter.id)?.status).toBe("idle");
    expect(
      (
        await harness.app.request(
          `/api/v1/threads/${occupied.thread.id}?experimental_includeDeleted=true`,
        )
      ).status,
    ).toBe(200);

    await advanceProjectDeletion(harness.deps, {
      projectId: occupied.project.id,
    });
    const retry = await waitForQueuedCommand(
      harness,
      ({ command, row }) =>
        command.type === "thread.storage.delete" &&
        command.threadId === occupied.thread.id &&
        row.id !== deletion.row.id,
    );
    await reportQueuedCommandSuccess(harness, retry, {
      providerCheckpointId: null,
    });
    await vi.waitFor(() =>
      expect(getThread(harness.db, waiter.id)?.status).toBe("active"),
    );
    expect(listQueuedThreadMessages(harness.db, waiter.id)).toEqual([]);
    expect(getThread(harness.db, occupied.thread.id)).not.toBeNull();
    await runThreadPurges(harness.deps);
    await advanceProjectDeletion(harness.deps, {
      projectId: occupied.project.id,
    });
    expect(getProject(harness.db, occupied.project.id)).toBeNull();
  });
});

it.each(["project deletion", "reconnect"] as const)(
  "releases an already-cleaned idle goal before purging during %s",
  async (path) => {
    await withTestHarness(async (harness) => {
      const occupied = seedDispatchThread(harness, { hostId: "storage-gone" });
      seedDispatchGoal(harness, occupied);
      const waiter = await queueCapacityWaiter(harness, occupied.thread.id);
      markThreadDeleted(harness.db, harness.hub, {
        threadId: occupied.thread.id,
      });
      markThreadStorageDeleted(harness.db, { threadId: occupied.thread.id });

      if (path === "project deletion") {
        beginProjectDeletion(harness.deps, { projectId: occupied.project.id });
      } else {
        await reconcileDaemonReportedThreads(harness.deps, {
          hostId: occupied.host.id,
          activeThreadIds: [],
          undeliveredEventThreadIds: [],
          sameDaemonInstance: false,
        });
      }

      expect(
        listRunningThreadsWithIntendedHosts(harness.deps, true).some(
          (row) => row.id === occupied.thread.id,
        ),
      ).toBe(false);
      await vi.waitFor(() =>
        expect(getThread(harness.db, waiter.id)?.status).toBe("active"),
      );
      expect(getThread(harness.db, occupied.thread.id)).not.toBeNull();
      expect(listQueuedThreadMessages(harness.db, waiter.id)).toEqual([]);
    });
  },
);

it("wakes a strict waiter when a partial purge removes occupancy before a later purge step fails", async () => {
  await withTestHarness(async (harness) => {
    const occupied = seedDispatchThread(harness, { hostId: "partial-purge" });
    const item = {
      type: "backgroundTask" as const,
      id: "retained-task",
      taskType: "local_bash",
      status: "pending" as const,
      taskStatus: "running",
      description: "Retained work",
      skipTranscript: false,
      foreground: false,
    };
    seedStoredEvent(harness.deps, {
      threadId: occupied.thread.id,
      sequence:
        getLatestThreadSequence(harness.db, { threadId: occupied.thread.id }) +
        1,
      type: "item/started",
      providerThreadId: occupied.providerThreadId,
      scope: threadScope(),
      itemId: item.id,
      itemKind: "backgroundTask",
      data: { item },
    });
    harness.db
      .update(threads)
      .set({
        deletedAt: Date.now(),
        storageDeletedAt: Date.now(),
      })
      .where(eq(threads.id, occupied.thread.id))
      .run();
    requestThreadPurge(harness.db, {
      now: Date.now(),
      threadId: occupied.thread.id,
    });
    harness.db.run(
      sql.raw(
        `CREATE TEMP TRIGGER fail_final_purge BEFORE DELETE ON threads WHEN old.id = '${occupied.thread.id}' BEGIN SELECT RAISE(ABORT, 'simulated final purge failure'); END`,
      ),
    );
    const waiter = await queueCapacityWaiter(harness, occupied.thread.id);

    try {
      await runThreadPurges(harness.deps);
      expect(listSweepItemFailures(harness.db, "thread-purge")).toMatchObject([
        {
          itemKey: occupied.thread.id,
          lastError: expect.stringContaining("simulated final purge failure"),
        },
      ]);
      expect(getThread(harness.db, occupied.thread.id)).not.toBeNull();
      expect(
        listRunningThreadsWithIntendedHosts(harness.deps, true).some(
          (row) => row.id === occupied.thread.id,
        ),
      ).toBe(false);
      await vi.waitFor(() =>
        expect(getThread(harness.db, waiter.id)?.status).toBe("active"),
      );
      expect(listQueuedThreadMessages(harness.db, waiter.id)).toEqual([]);
    } finally {
      harness.db.run(sql`DROP TRIGGER fail_final_purge`);
    }
  });
});
