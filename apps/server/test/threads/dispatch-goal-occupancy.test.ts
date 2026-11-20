import { handleDaemonSocketClosed } from "../../src/internal/session-owner-side-effects.js";
import { listEvents } from "@bb/db/testing";
import {
  createQueuedThreadMessage,
  getThread,
  listQueuedThreadMessages,
  readThreadRunState,
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
  stopThreadForCurrentState,
} from "../../src/services/threads/thread-lifecycle.js";
import {
  installAdmissionHooks,
  postDispatchEvents,
  seedDispatchGoal,
  seedDispatchThread,
} from "../helpers/dispatch-admission.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { withTestHarness } from "../helpers/test-app.js";

afterEach(() => setPluginHookProvider(undefined));

it.each([false, true])(
  "releases an idle native goal and its waiter only after archive confirmation (unconfirmed request: %s)",
  async (unconfirmedRequest) => {
    await withTestHarness(async (harness) => {
      const occupied = seedDispatchThread(harness, { hostId: "archived-goal" });
      seedDispatchGoal(harness, occupied);
      if (unconfirmedRequest) {
        await acceptThreadSendRequest(harness.deps, {
          thread: occupied.thread,
          payload: { input: textInput("Continue the goal"), mode: "auto" },
        });
        const submit = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "turn.submit" &&
            command.threadId === occupied.thread.id,
        );
        expect(
          (
            await postDispatchEvents(harness, occupied.session, [
              {
                type: "turn/started",
                threadId: occupied.thread.id,
                providerThreadId: occupied.providerThreadId,
                scope: turnScope("unconfirmed-goal-turn"),
              },
              {
                type: "turn/completed",
                threadId: occupied.thread.id,
                providerThreadId: occupied.providerThreadId,
                scope: turnScope("unconfirmed-goal-turn"),
                status: "completed",
              },
            ])
          ).status,
        ).toBe(200);
        await reportQueuedCommandError(harness, submit, {
          errorCode: "turn_start_unconfirmed",
          errorMessage: "The provider start answer was lost",
        });
        expect(getThread(harness.db, occupied.thread.id)?.status).toBe("idle");
        expect(
          readThreadRunState(harness.db, occupied.thread.id).requests,
        ).toMatchObject([{ phase: "unconfirmed" }]);
      }
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
  },
);

it("dispatches a persisted stopping waiter immediately after an idle release", async () => {
  await withTestHarness(async (harness) => {
    const fixture = seedDispatchThread(harness, { hostId: "release-waiter" });
    const stopped = stopThreadForCurrentState(
      harness.deps,
      fixture.thread,
      fixture.environment,
    );
    const stop = await waitForQueuedCommand(
      harness,
      ({ command }) =>
        command.type === "thread.stop" &&
        command.threadId === fixture.thread.id &&
        command.intent === "release",
    );
    createQueuedThreadMessage(harness.db, harness.deps.hub, {
      threadId: fixture.thread.id,
      content: textInput("Resume after stopping"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      payload: { kind: "inline" },
      waitingOn: { kind: "stopping" },
      sendAt: null,
      systemNotice: null,
    });
    await reportQueuedCommandSuccess(harness, stop, {
      providerCheckpointId: null,
    });
    await stopped;
    await vi.waitFor(() => {
      expect(listQueuedThreadMessages(harness.db, fixture.thread.id)).toEqual(
        [],
      );
      expect(getThread(harness.db, fixture.thread.id)?.status).toBe("active");
    });
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
      turnCommandThreadIds: [],
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

it("retains an idle native goal through a socket drop and same-instance reconciliation", async () => {
  await withTestHarness(async (harness) => {
    const fixture = seedDispatchThread(harness, { hostId: "resumable-goal" });
    seedDispatchGoal(harness, fixture);
    handleDaemonSocketClosed(harness.deps, { sessionId: fixture.session.id });
    expect(
      listRunningThreadsWithIntendedHosts(harness.deps, true),
    ).toContainEqual({ id: fixture.thread.id, hostId: fixture.host.id });
    await reconcileDaemonReportedThreads(harness.deps, {
      hostId: fixture.host.id,
      activeThreadIds: [],
      turnCommandThreadIds: [],
      undeliveredEventThreadIds: [],
      sameDaemonInstance: true,
    });
    expect(
      listRunningThreadsWithIntendedHosts(harness.deps, true),
    ).toContainEqual({ id: fixture.thread.id, hostId: fixture.host.id });
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
