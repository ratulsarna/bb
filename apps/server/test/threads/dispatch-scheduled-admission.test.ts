import { getThread, listQueuedThreadMessages } from "@bb/db";
import { afterEach, expect, it, vi } from "vitest";
import { setPluginHookProvider } from "../../src/services/plugins/plugin-hook-registry.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import {
  installAdmissionHooks,
  seedDispatchThread,
} from "../helpers/dispatch-admission.js";
import { textInput } from "../helpers/prompt-input.js";
import { withTestHarness } from "../helpers/test-app.js";

afterEach(() => {
  setPluginHookProvider(undefined);
  vi.restoreAllMocks();
});

it.each(["unscheduled", "earlier", "later"] as const)(
  "keeps the user's schedule when a strict wait is %s",
  async (schedule) => {
    await withTestHarness(async (harness) => {
      const { thread } = seedDispatchThread(harness, { hostId: "scheduled" });
      const now = Date.now();
      const requestedSendAt = now + 60_000;
      const hookSendAt =
        schedule === "unscheduled"
          ? null
          : now + (schedule === "earlier" ? 30_000 : 120_000);
      const dueAt = Math.max(requestedSendAt, hookSendAt ?? 0);
      let held = true;
      installAdmissionHooks([
        {
          pluginId: "capacity",
          experimental_enforcement: "strict",
          handler: () =>
            held
              ? { action: "wait", reason: "Full", sendAt: hookSendAt }
              : { action: "proceed" },
        },
      ]);
      await expect(
        acceptThreadSendRequest(harness.deps, {
          thread,
          payload: {
            input: textInput("Send after the requested time"),
            mode: "auto",
            sendAt: requestedSendAt,
          },
        }),
      ).resolves.toMatchObject({ delivery: "queued" });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([
        expect.objectContaining({ sendAt: dueAt }),
      ]);

      held = false;
      await runQueuedMessageDispatch(harness.deps, {
        kind: "dispatch-admission-released",
      });
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([
        expect.objectContaining({ sendAt: dueAt }),
      ]);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "time-reached",
        now: dueAt - 1,
      });
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");

      vi.spyOn(Date, "now").mockReturnValue(dueAt);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "time-reached",
        now: dueAt,
      });
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    });
  },
);
