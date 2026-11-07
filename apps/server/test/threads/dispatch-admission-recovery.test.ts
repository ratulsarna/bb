import {
  getThread,
  getLatestThreadSequence,
  listQueuedThreadMessages,
  threads,
  type SlowDbQueryLogFields,
} from "@bb/db";
import { inArray } from "drizzle-orm";
import { threadScope, turnScope } from "@bb/domain";
import { createDeferredPromise } from "@bb/test-helpers";
import { afterEach, expect, it, vi } from "vitest";
import { setPluginHookProvider } from "../../src/services/plugins/plugin-hook-registry.js";
import { listRunningThreadsWithIntendedHosts } from "../../src/services/threads/dispatch-attempt.js";
import { noteDispatchRequeued } from "../../src/services/threads/dispatch-hooks.js";
import { reserveDispatchAdmission } from "../../src/services/threads/dispatch-admission.js";
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
import {
  listQueuedThreadCommands,
  reportQueuedCommandError,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import { seedStoredEvent, seedThread } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

afterEach(() => setPluginHookProvider(undefined));

it("batches bulk runtime status notifications into one release check and wakes a real waiter", async () => {
  const queries: SlowDbQueryLogFields[] = [];
  await withTestHarness(
    {
      databaseOptions: {
        slowQueryThresholdMs: 0,
        slowQueryLogger: {
          info: (fields) => {
            queries.push(fields);
          },
        },
      },
    },
    async (harness) => {
      const occupied = seedDispatchThread(harness, {
        hostId: "occupied",
        status: "active",
      });
      const bulk = Array.from({ length: 64 }, () =>
        seedThread(harness.deps, {
          projectId: occupied.project.id,
          environmentId: occupied.environment.id,
          status: "active",
        }),
      );
      harness.db
        .update(threads)
        .set({ archivedAt: Date.now() })
        .where(
          inArray(
            threads.id,
            bulk.slice(0, 32).map((row) => row.id),
          ),
        )
        .run();
      harness.db
        .update(threads)
        .set({ deletedAt: Date.now() })
        .where(
          inArray(
            threads.id,
            bulk.slice(32).map((row) => row.id),
          ),
        )
        .run();
      const { thread: waiter } = seedDispatchThread(harness, {
        hostId: "waiting",
      });
      const hook = vi.fn(() =>
        listRunningThreadsWithIntendedHosts(harness.deps, true).some(
          (row) => row.id === occupied.thread.id,
        )
          ? { action: "wait" as const, reason: "Full" }
          : { action: "proceed" as const },
      );
      installAdmissionHooks([
        {
          pluginId: "capacity",
          experimental_enforcement: "strict",
          handler: hook,
        },
      ]);
      await expect(
        acceptThreadSendRequest(harness.deps, {
          thread: waiter,
          payload: { input: textInput("Waiting work"), mode: "auto" },
        }),
      ).resolves.toMatchObject({ delivery: "queued" });
      hook.mockClear();

      queries.length = 0;
      for (const thread of bulk)
        harness.hub.notifyThread(thread.id, ["status-changed"]);
      expect(queries).toEqual([]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(queries).toHaveLength(1);
      expect(queries[0]).toMatchObject({ operation: "get" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(hook).not.toHaveBeenCalled();

      const completion = postDispatchEvents(harness, occupied.session, [
        {
          type: "turn/completed",
          threadId: occupied.thread.id,
          providerThreadId: occupied.providerThreadId,
          scope: turnScope(occupied.turnId),
          status: "completed",
        },
      ]);
      for (const thread of bulk)
        harness.hub.notifyThread(thread.id, ["status-changed"]);
      expect((await completion).status).toBe(200);
      await vi.waitFor(() =>
        expect(getThread(harness.db, waiter.id)?.status).toBe("active"),
      );
      expect(listQueuedThreadMessages(harness.db, waiter.id)).toEqual([]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(hook).toHaveBeenCalledOnce();
    },
  );
});

it.each(["active", "background", "goal", "reservation"] as const)(
  "does not wake capacity waiters for progress while a thread occupies through %s",
  async (occupancy) => {
    await withTestHarness(async (harness) => {
      const occupied = seedDispatchThread(harness, {
        hostId: "occupied",
        status: occupancy === "active" ? "active" : "idle",
      });
      if (occupancy === "goal") seedDispatchGoal(harness, occupied);
      if (occupancy === "background")
        seedStoredEvent(harness.deps, {
          threadId: occupied.thread.id,
          sequence:
            getLatestThreadSequence(harness.db, {
              threadId: occupied.thread.id,
            }) + 1,
          type: "item/started",
          providerThreadId: occupied.providerThreadId,
          scope: threadScope(),
          itemId: "running-command",
          itemKind: "backgroundTask",
          data: {
            item: {
              type: "backgroundTask",
              id: "running-command",
              taskType: "local_bash",
              status: "pending",
              taskStatus: "running",
              description: "Working",
              skipTranscript: true,
              foreground: false,
            },
          },
        });
      const releaseReservation =
        occupancy === "reservation"
          ? reserveDispatchAdmission(harness.deps, {
              id: occupied.thread.id,
              hostId: occupied.host.id,
            })
          : undefined;
      try {
        const { thread: waiter } = seedDispatchThread(harness, {
          hostId: "waiting",
        });
        const hook = vi.fn(() =>
          listRunningThreadsWithIntendedHosts(harness.deps, true).some(
            (row) => row.id === occupied.thread.id,
          )
            ? { action: "wait" as const, reason: "Full" }
            : { action: "proceed" as const },
        );
        installAdmissionHooks([
          {
            pluginId: "capacity",
            experimental_enforcement: "strict",
            handler: hook,
          },
        ]);
        await expect(
          acceptThreadSendRequest(harness.deps, {
            thread: waiter,
            payload: { input: textInput("Waiting work"), mode: "auto" },
          }),
        ).resolves.toMatchObject({ delivery: "queued" });
        hook.mockClear();
        for (let index = 0; index < 20; index += 1) {
          harness.hub.notifyThread(occupied.thread.id, ["events-appended"], {
            eventTypes: ["item/backgroundTask/progress"],
          });
          await new Promise<void>((resolve) => setImmediate(resolve));
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(hook).not.toHaveBeenCalled();
        expect(getThread(harness.db, waiter.id)?.status).toBe("idle");
        expect(listQueuedThreadMessages(harness.db, waiter.id)).toHaveLength(1);
      } finally {
        releaseReservation?.();
      }
    });
  },
);

it.each([
  "daemon restart",
  "connection loss",
  "reconciliation",
  "pre-start stop",
  "final start failure",
] as const)(
  "dispatches a capacity waiter after %s without a plugin recheck",
  async (release) => {
    await withTestHarness(async (harness) => {
      const occupied = seedDispatchThread(harness, {
        hostId: "occupied",
        status:
          release === "pre-start stop"
            ? "starting"
            : release === "reconciliation"
              ? "stopping"
              : release === "final start failure"
                ? "idle"
                : "active",
        attached: release !== "pre-start stop",
      });
      if (release === "final start failure") {
        await acceptThreadSendRequest(harness.deps, {
          thread: occupied.thread,
          payload: { input: textInput("Start"), mode: "auto" },
        });
        const command = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "turn.submit" &&
            command.threadId === occupied.thread.id,
        );
        await reportQueuedCommandError(harness, command, {
          errorCode: "turn_start_unconfirmed",
          errorMessage: "Start is not confirmed",
        });
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
      noteDispatchRequeued(waiter.id);
      if (release === "daemon restart" || release === "connection loss")
        interruptActiveThreadsForHost(harness.deps, {
          hostId: occupied.host.id,
          includeStopping: false,
          reason: "host-daemon-restarted",
          ...(release === "connection loss"
            ? { cause: "host-connection-lost" as const }
            : {}),
          resumingThreadIds: new Set(),
        });
      else if (release === "reconciliation")
        await reconcileDaemonReportedThreads(harness.deps, {
          hostId: occupied.host.id,
          activeThreadIds: [],
          undeliveredEventThreadIds: [],
          sameDaemonInstance: true,
        });
      else if (release === "pre-start stop")
        expect(
          (
            await harness.app.request(
              `/api/v1/threads/${occupied.thread.id}/stop`,
              { method: "POST" },
            )
          ).status,
        ).toBe(200);
      else
        expect(
          (
            await postDispatchEvents(harness, occupied.session, [
              {
                type: "system/error",
                threadId: occupied.thread.id,
                scope: threadScope(),
                code: "provider_turn_start_failed",
                message: "Final start failure",
              },
            ])
          ).status,
        ).toBe(200);
      await vi.waitFor(
        () => expect(getThread(harness.db, waiter.id)?.status).toBe("active"),
        { timeout: 2_000 },
      );
      expect(listQueuedThreadMessages(harness.db, waiter.id)).toEqual([]);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", waiter.id),
      ).toHaveLength(1);
    });
  },
);

it("rechecks a wait when capacity is released during its hook decision", async () => {
  await withTestHarness(async (harness) => {
    const occupied = seedDispatchThread(harness, {
      hostId: "occupied",
      status: "active",
    });
    const { thread: waiter } = seedDispatchThread(harness, {
      hostId: "waiting",
    });
    const entered = createDeferredPromise<void>();
    const resume = createDeferredPromise<void>();
    installAdmissionHooks([
      {
        pluginId: "capacity",
        experimental_enforcement: "strict",
        handler: async () => {
          const full = listRunningThreadsWithIntendedHosts(
            harness.deps,
            true,
          ).some((row) => row.id === occupied.thread.id);
          entered.resolve();
          await resume.promise;
          return full
            ? { action: "wait", reason: "Full" }
            : { action: "proceed" };
        },
      },
    ]);
    const sending = acceptThreadSendRequest(harness.deps, {
      thread: waiter,
      payload: { input: textInput("Waiting work"), mode: "auto" },
    });
    try {
      await entered.promise;
      expect(
        (
          await postDispatchEvents(harness, occupied.session, [
            {
              type: "turn/completed",
              threadId: occupied.thread.id,
              providerThreadId: occupied.providerThreadId,
              scope: turnScope(occupied.turnId),
              status: "completed",
            },
          ])
        ).status,
      ).toBe(200);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      resume.resolve();
    }
    await sending;
    await vi.waitFor(
      () => expect(getThread(harness.db, waiter.id)?.status).toBe("active"),
      { timeout: 2_000 },
    );
    expect(listQueuedThreadMessages(harness.db, waiter.id)).toEqual([]);
  });
});
