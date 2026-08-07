// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExperimentsSettingsSection } from "./SettingsView";

afterEach(cleanup);

function renderSection(overrides?: {
  onCloudAiEnabledChange?: (enabled: boolean) => void;
  onNewOnboardingEnabledChange?: (enabled: boolean) => void;
  onToolsHubEnabledChange?: (enabled: boolean) => void;
}) {
  return render(
    <ExperimentsSettingsSection
      claudeCodeMockCliTrafficEnabled={false}
      cloudAiEnabled={false}
      disabled={false}
      newOnboardingEnabled={false}
      onClaudeCodeMockCliTrafficEnabledChange={vi.fn()}
      onCloudAiEnabledChange={overrides?.onCloudAiEnabledChange ?? vi.fn()}
      onNewOnboardingEnabledChange={
        overrides?.onNewOnboardingEnabledChange ?? vi.fn()
      }
      onToolsHubEnabledChange={overrides?.onToolsHubEnabledChange ?? vi.fn()}
      toolsHubEnabled={false}
    />,
  );
}

describe("ExperimentsSettingsSection", () => {
  it("reports Cloud AI changes", () => {
    const onChange = vi.fn();
    renderSection({ onCloudAiEnabledChange: onChange });
    fireEvent.click(screen.getByLabelText("Cloud AI"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("reports new onboarding changes", () => {
    const onChange = vi.fn();
    renderSection({ onNewOnboardingEnabledChange: onChange });
    fireEvent.click(screen.getByLabelText("New onboarding"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("reports Extensions changes", () => {
    const onChange = vi.fn();
    renderSection({ onToolsHubEnabledChange: onChange });
    const toggle = screen.getByLabelText("Extensions");
    expect(toggle.hasAttribute("disabled")).toBe(false);
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
