import { PetSettings } from './DesktopPet';
import type { Project } from '../shared/protocol';

export function PluginSettingsPanel({ projects, currentProjectId, apiVersion }: {
  projects: Project[];
  currentProjectId?: string;
  apiVersion: number;
}) {
  return <div className="plugin-builtin-settings">
    <PetSettings projects={projects} currentProjectId={currentProjectId} apiVersion={apiVersion} />
  </div>;
}
