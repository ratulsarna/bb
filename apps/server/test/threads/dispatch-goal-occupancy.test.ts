import { getThread, listQueuedThreadMessages } from "@bb/db";
import { threadScope, turnScope, type ThreadEvent } from "@bb/domain";
import { afterEach, expect, it, vi } from "vitest";
import { setPluginHookProvider } from "../../src/services/plugins/plugin-hook-registry.js";
import { listRunningThreadsWithIntendedHosts } from "../../src/services/threads/dispatch-attempt.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import { interruptActiveThreadsForHost } from "../../src/services/threads/thread-lifecycle.js";
import {
  installAdmissionHooks,
  postDispatchEvents,
  seedDispatchGoal,
  seedDispatchThread,
} from "../helpers/dispatch-admission.js";
import { textInput } from "../helpers/prompt-input.js";
import { withTestHarness } from "../helpers/test-app.js";

afterEach(() => setPluginHookProvider(undefined));

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
