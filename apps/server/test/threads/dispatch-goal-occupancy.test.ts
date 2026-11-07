import {
  getThread,
  listEvents,
  listQueuedThreadMessages,
  threads,
} from "@bb/db";
import { eq } from "drizzle-orm";
import { threadScope, turnScope, type ThreadEvent } from "@bb/domain";
import { afterEach, expect, it, vi } from "vitest";
import { setPluginHookProvider } from "../../src/services/plugins/plugin-hook-registry.js";
import { listRunningThreadsWithIntendedHosts } from "../../src/services/threads/dispatch-attempt.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import {
  interruptActiveThreadsForHost,
  reconcileDaemonReportedThreads,
} from "../../src/services/threads/thread-lifecycle.js";
import {
  installAdmissionHooks,
  postDispatchEvents,
  seedDispatchGoal,
  seedDispatchThread,
} from "../helpers/dispatch-admission.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { withTestHarness } from "../helpers/test-app.js";

afterEach(() => setPluginHookProvider(undefined));

it("releases an idle native goal and its waiter only after archive confirmation", async () => {
  await withTestHarness(async (harness) => {
    const occupied = seedDispatchThread(harness, { hostId: "archived-goal" });
    seedDispatchGoal(harness, occupied);
    const { thread: waiter } = seedDispatchThread(harness, {
      hostId: "waiting",
    });
    installAdmissionHooks([
      {
        pluginId: "capacity",
        experimental_enforcement: "strict",
        handler: () =>
          listRunningThreadsWithIntendedHosts(harness.deps, true).some(
            (row) => row.id === occupied.thread.id,
          )
            ? { action: "wait", reason: "Full" }
            : { action: "proceed" },
      },
    ]);
    await expect(
      acceptThreadSendRequest(harness.deps, {
        thread: waiter,
        payload: { input: textInput("Waiting work"), mode: "auto" },
      }),
    ).resolves.toMatchObject({ delivery: "queued" });
    expect(
      (
        await harness.app.request(
          `/api/v1/threads/${occupied.thread.id}/archive-all`,
          { method: "POST" },
        )
      ).status,
    ).toBe(200);
    const archive = await waitForQueuedCommand(
      harness,
      ({ command }) =>
        command.type === "thread.archive" &&
        command.threadId === occupied.thread.id,
    );
    expect(getThread(harness.db, occupied.thread.id)).toMatchObject({
      archivedAt: expect.any(Number),
      status: "idle",
    });
    expect(
      listRunningThreadsWithIntendedHosts(harness.deps, true).some(
        (row) => row.id === occupied.thread.id,
      ),
    ).toBe(true);
    expect(getThread(harness.db, waiter.id)?.status).toBe("idle");
    await reportQueuedCommandSuccess(harness, archive, {});
    expect(
      listRunningThreadsWithIntendedHosts(harness.deps, true).some(
        (row) => row.id === occupied.thread.id,
      ),
    ).toBe(false);
    await vi.waitFor(() =>
      expect(getThread(harness.db, waiter.id)?.status).toBe("active"),
    );
    expect(listQueuedThreadMessages(harness.db, waiter.id)).toEqual([]);
  });
});

it("settles a stopping goal after a daemon restart without a failure banner", async () => {
  await withTestHarness(async (harness) => {
    const fixture = seedDispatchThread(harness, {
      hostId: "stopping-goal",
      status: "stopping",
    });
    seedDispatchGoal(harness, fixture);
    const { thread: waiter } = seedDispatchThread(harness, {
      hostId: "waiting",
    });
    installAdmissionHooks([
      {
        pluginId: "capacity",
        experimental_enforcement: "strict",
        handler: () =>
          listRunningThreadsWithIntendedHosts(harness.deps, true).some(
            (row) => row.id === fixture.thread.id,
          )
            ? { action: "wait", reason: "Full" }
            : { action: "proceed" },
      },
    ]);
    await expect(
      acceptThreadSendRequest(harness.deps, {
        thread: waiter,
        payload: { input: textInput("Waiting work"), mode: "auto" },
      }),
    ).resolves.toMatchObject({ delivery: "queued" });
    interruptActiveThreadsForHost(harness.deps, {
      hostId: fixture.host.id,
      includeStopping: false,
      reason: "host-daemon-restarted",
      resumingThreadIds: new Set(),
    });
    expect(getThread(harness.db, fixture.thread.id)?.status).toBe("stopping");
    await reconcileDaemonReportedThreads(harness.deps, {
      hostId: fixture.host.id,
      activeThreadIds: [],
      undeliveredEventThreadIds: [],
      sameDaemonInstance: false,
    });
    expect(getThread(harness.db, fixture.thread.id)?.status).toBe("idle");
    expect(
      listRunningThreadsWithIntendedHosts(harness.deps, true).some(
        (row) => row.id === fixture.thread.id,
      ),
    ).toBe(false);
    expect(
      listEvents(harness.db, { threadId: fixture.thread.id }).filter(
        (event) => event.type === "system/error",
      ),
    ).toEqual([]);
    await vi.waitFor(() =>
      expect(getThread(harness.db, waiter.id)?.status).toBe("active"),
    );
    expect(listQueuedThreadMessages(harness.db, waiter.id)).toEqual([]);
  });
});

it("leaves retained deleted goal runtimes to deletion reconciliation", async () => {
  await withTestHarness(async (harness) => {
    const fixture = seedDispatchThread(harness, {
      hostId: "deleted-goal",
      status: "active",
    });
    seedDispatchGoal(harness, fixture);
    harness.db
      .update(threads)
      .set({ deletedAt: Date.now() })
      .where(eq(threads.id, fixture.thread.id))
      .run();
    const before = listEvents(harness.db, { threadId: fixture.thread.id });
    interruptActiveThreadsForHost(harness.deps, {
      hostId: fixture.host.id,
      includeStopping: true,
      reason: "host-daemon-restarted",
      resumingThreadIds: new Set(),
    });
    expect(listEvents(harness.db, { threadId: fixture.thread.id })).toEqual(
      before,
    );
    expect(getThread(harness.db, fixture.thread.id)?.status).toBe("active");
  });
});

it.each([
  { loss: "provider exit", status: "active" },
  { loss: "provider exit", status: "idle" },
  { loss: "daemon restart", status: "active" },
  { loss: "daemon restart", status: "idle" },
  { loss: "connection loss", status: "active" },
  { loss: "connection loss", status: "idle" },
] as const)(
  "releases a $status goal and its capacity waiter after $loss",
  async ({ loss, status }) => {
    await withTestHarness(async (harness) => {
      const occupied = seedDispatchThread(harness, {
        hostId: "occupied",
        status,
      });
      seedDispatchGoal(harness, occupied);
      const { thread: waiter } = seedDispatchThread(harness, {
        hostId: "waiting",
      });
      installAdmissionHooks([
        {
          pluginId: "capacity",
          experimental_enforcement: "strict",
          handler: () =>
            listRunningThreadsWithIntendedHosts(harness.deps, true).some(
              (row) => row.id === occupied.thread.id,
            )
              ? { action: "wait", reason: "Full" }
              : { action: "proceed" },
        },
      ]);
      await expect(
        acceptThreadSendRequest(harness.deps, {
          thread: waiter,
          payload: { input: textInput("Waiting work"), mode: "auto" },
        }),
      ).resolves.toMatchObject({ delivery: "queued" });
      if (loss === "provider exit") {
        const events: ThreadEvent[] = [
          {
            type: "system/error",
            threadId: occupied.thread.id,
            scope: threadScope(),
            code: "provider_process_exited",
            message: "Provider died",
          },
        ];
        if (status === "active")
          events.unshift({
            type: "turn/completed",
            threadId: occupied.thread.id,
            providerThreadId: occupied.providerThreadId,
            scope: turnScope(occupied.turnId),
            status: "failed",
          });
        expect(
          (await postDispatchEvents(harness, occupied.session, events)).status,
        ).toBe(200);
      } else {
        interruptActiveThreadsForHost(harness.deps, {
          hostId: occupied.host.id,
          includeStopping: false,
          reason: "host-daemon-restarted",
          ...(loss === "connection loss"
            ? { cause: "host-connection-lost" }
            : {}),
          resumingThreadIds: new Set(),
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
      expect(listQueuedThreadMessages(harness.db, waiter.id)).toEqual([]);
    });
  },
);
