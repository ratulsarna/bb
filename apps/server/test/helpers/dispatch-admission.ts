import type { PluginHookName } from "@get-bb/plugin-sdk";
import { getLatestThreadSequence } from "@bb/db";
import {
  LEGACY_CODEX_GOAL_EXTENSION_KIND,
  threadScope,
  type Thread,
  type ThreadEvent,
} from "@bb/domain";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import {
  invokePluginInline,
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { internalAuthHeaders } from "./commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedStoredEvent,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "./seed.js";
import type { TestAppHarness } from "./test-app.js";

export function seedDispatchThread(
  harness: TestAppHarness,
  args: { hostId: string; status?: Thread["status"]; attached?: boolean },
) {
  const { host, session } = seedHostSession(harness.deps, { id: args.hostId });
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: args.attached === false ? null : environment.id,
    status: args.status ?? "idle",
  });
  const providerThreadId = `provider-${thread.id}`;
  const turnId = `turn-${thread.id}`;
  seedThreadRuntimeState(harness.deps, {
    environmentId: thread.environmentId,
    threadId: thread.id,
    providerThreadId,
  });
  if (thread.status === "active")
    seedTurnStarted(harness.deps, {
      threadId: thread.id,
      environmentId: thread.environmentId,
      providerThreadId,
      turnId,
    });
  return {
    thread,
    host,
    session,
    project,
    environment,
    providerThreadId,
    turnId,
  };
}

export function installAdmissionHooks(
  hooks: PluginHookRegistration<"message.dispatch">[],
): void {
  const registry: { [K in PluginHookName]: PluginHookRegistration<K>[] } = {
    "message.dispatch": hooks,
  };
  setPluginHookProvider({
    listHooks: (hook) => registry[hook],
    invokeHook: (_id, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 10_000,
  });
}

export function seedDispatchGoal(
  harness: TestAppHarness,
  fixture: ReturnType<typeof seedDispatchThread>,
): void {
  seedStoredEvent(harness.deps, {
    threadId: fixture.thread.id,
    sequence:
      getLatestThreadSequence(harness.db, { threadId: fixture.thread.id }) + 1,
    type: "thread/extensionState/updated",
    providerThreadId: fixture.providerThreadId,
    scope: threadScope(),
    data: {
      kind: LEGACY_CODEX_GOAL_EXTENSION_KIND,
      payload: {
        objective: "Finish the task",
        status: "active",
        tokenBudget: null,
        tokensUsed: 1,
        timeUsedSeconds: 1,
      },
    },
  });
}

export function postDispatchEvents(
  harness: TestAppHarness,
  session: ReturnType<typeof seedDispatchThread>["session"],
  events: ThreadEvent[],
) {
  return harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(harness, { hostId: session.hostId }),
    body: JSON.stringify({
      sessionId: session.id,
      eventGroups: groupHostDaemonEvents(
        events.map((event) => ({ threadId: event.threadId, event })),
      ),
    }),
  });
}
