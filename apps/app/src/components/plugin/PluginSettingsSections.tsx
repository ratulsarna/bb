import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import {
  usePluginSlots,
  type PluginSettingsSectionSlot,
} from "@/lib/plugin-slots";
import { PluginSlotMount } from "./PluginSlotMount";
import {
  ResourceDetailPanel,
  ResourceDetailConfigurationSection,
} from "@bb/shared-ui/resource-list";

const CONNECT_PLUGIN_ID = "connect";
const CLOUD_AI_SECTION_ID = "cloud-ai";

function isSettingsSectionVisible(
  section: PluginSettingsSectionSlot,
  cloudAiEnabled: boolean,
): boolean {
  return !(
    section.pluginId === CONNECT_PLUGIN_ID &&
    section.id === CLOUD_AI_SECTION_ID &&
    !cloudAiEnabled
  );
}

/**
 * Plugin `settingsSection` slot mounts, rendered on that plugin's canonical
 * Plugins detail page below the host-rendered declarative form.
 * Each section is contained in its own per-plugin error boundary.
 */
export function PluginSettingsSections({ pluginId }: { pluginId: string }) {
  const { settingsSections } = usePluginSlots();
  const cloudAiEnabled = useSystemConfig().data?.experiments?.cloudAi === true;
  const sections = settingsSections.filter(
    (section) =>
      section.pluginId === pluginId &&
      isSettingsSectionVisible(section, cloudAiEnabled),
  );
  if (sections.length === 0) return null;
  return <PluginSettingsSectionList sections={sections} />;
}

function PluginSettingsSectionList({
  sections,
}: {
  sections: readonly PluginSettingsSectionSlot[];
}) {
  const location = useLocation();

  useEffect(() => {
    if (location.hash.length <= 1) return;
    let sectionId: string;
    try {
      sectionId = decodeURIComponent(location.hash.slice(1));
    } catch {
      return;
    }
    if (!sections.some((section) => section.id === sectionId)) return;
    document.getElementById(sectionId)?.scrollIntoView({ block: "start" });
  }, [location.hash, location.key, sections]);

  return (
    <div className="space-y-6" data-testid="plugin-settings-sections">
      {sections.map((section) => {
        const key = `${section.pluginId}/${section.id}/${section.generation}`;
        return (
          <div key={key} id={section.id} className="scroll-mt-4">
            {section.title === undefined ? (
              <PluginSettingsSectionPanel section={section} />
            ) : (
              <ResourceDetailConfigurationSection label={section.title}>
                <PluginSettingsSectionPanel section={section} />
              </ResourceDetailConfigurationSection>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PluginSettingsSectionPanel({
  section,
}: {
  section: PluginSettingsSectionSlot;
}) {
  return (
    <ResourceDetailPanel surface="recessed" className="px-3 py-3">
      {section.description !== undefined ? (
        <p className="mb-3 text-xs leading-snug text-subtle-foreground/75">
          {section.description}
        </p>
      ) : null}
      <PluginSlotMount
        pluginId={section.pluginId}
        slotKind="settingsSection"
        slotId={section.id}
      >
        <section.component />
      </PluginSlotMount>
    </ResourceDetailPanel>
  );
}
