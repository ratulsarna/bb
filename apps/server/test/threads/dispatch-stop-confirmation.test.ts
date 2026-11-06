import {
  getLatestThreadSequence,
  getThread,
  listActiveBackgroundTaskCountsByThreadIds,
  listEvents,
  listQueuedThreadMessages,
} from "@bb/db";
import { threadScope, THREAD_RUNTIME_STOPPED_OPERATION } from "@bb/domain";
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
  seedDispatchGoal,
  seedDispatchThread,
} from "../helpers/dispatch-admission.js";
import {
  reportQueuedCommandError,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { seedStoredEvent } from "../helpers/seed.js";
import { textInput } from "../helpers/prompt-input.js";
import { withTestHarness } from "../helpers/test-app.js";

afterEach(() => setPluginHookProvider(undefined));

it.each(["command_timeout", "host_unavailable"] as const)(
  "keeps capacity after an unconfirmed %s Stop until reconciliation reports the runtime gone",
  async (errorCode) => {
    await withTestHarness(async (harness) => {
      const occupied = seedDispatchThread(harness, {
        hostId: "occupied",
        status: "active",
      });
      seedDispatchGoal(harness, occupied);
      seedStoredEvent(harness.deps, {
        threadId: occupied.thread.id,
        sequence:
          getLatestThreadSequence(harness.db, {
            threadId: occupied.thread.id,
          }) + 1,
        type: "item/started",
        providerThreadId: occupied.providerThreadId,
        scope: threadScope(),
        itemId: "unfinished-command",
        itemKind: "backgroundTask",
        data: {
          item: {
            type: "backgroundTask",
            id: "unfinished-command",
            taskType: "local_bash",
            status: "pending",
            taskStatus: "running",
            description: "Working",
            skipTranscript: false,
            foreground: false,
          },
        },
      });

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
      await acceptThreadSendRequest(harness.deps, {
        thread: waiter,
        payload: { input: textInput("Waiting work"), mode: "auto" },
      });
      const stopping = harness.app.request(
        `/api/v1/threads/${occupied.thread.id}/stop`,
        { method: "POST" },
      );
      const stop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" &&
          command.threadId === occupied.thread.id,
      );
      await reportQueuedCommandError(harness, stop, {
        errorCode,
        errorMessage: "No stop acknowledgement",
      });
      await stopping;
      interruptActiveThreadsForHost(harness.deps, {
        hostId: occupied.host.id,
        includeStopping: false,
        reason: "host-daemon-restarted",
        cause: "host-connection-lost",
        resumingThreadIds: new Set(),
      });
      expect(getThread(harness.db, occupied.thread.id)?.status).toBe(
        "stopping",
      );
      expect(
        listRunningThreadsWithIntendedHosts(harness.deps, true),
      ).toContainEqual({ id: occupied.thread.id, hostId: occupied.host.id });
      expect(
        listEvents(harness.db, { threadId: occupied.thread.id }).some(
          (event) =>
            event.type === "system/operation" &&
            JSON.parse(event.data).operation ===
              THREAD_RUNTIME_STOPPED_OPERATION,
        ),
      ).toBe(false);
      expect(
        listActiveBackgroundTaskCountsByThreadIds(harness.db, {
          threadIds: [occupied.thread.id],
        }),
      ).toMatchObject([{ activeBackgroundCommandCount: 1 }]);
      expect(getThread(harness.db, waiter.id)?.status).toBe("idle");
      expect(listQueuedThreadMessages(harness.db, waiter.id)).toHaveLength(1);
      await reconcileDaemonReportedThreads(harness.deps, {
        hostId: occupied.host.id,
        activeThreadIds: [],
        undeliveredEventThreadIds: [],
        sameDaemonInstance: true,
      });
      await vi.waitFor(() =>
        expect(getThread(harness.db, waiter.id)?.status).toBe("active"),
      );
      expect(
        listRunningThreadsWithIntendedHosts(harness.deps, true).some(
          (row) => row.id === occupied.thread.id,
        ),
      ).toBe(false);
      expect(listQueuedThreadMessages(harness.db, waiter.id)).toEqual([]);
    });
  },
);
