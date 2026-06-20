/**
 * Shared app/manifest types. The manifest is the contract OpenMasjidAPPS must
 * follow (docs/APP_MANIFEST_SPEC.md). The platform never holds masjid data —
 * an app collects everything it needs through its own `settings` block.
 */

export interface SettingField {
  key: string;
  label: string;
  type: 'text' | 'select' | 'number' | 'password' | 'boolean';
  options?: string[];
  default?: string;
}

export interface PortSpec {
  container: number;
  label?: string;
}

/** A catalog entry as published by OpenMasjidAPPS in catalog.json. */
export interface CatalogApp {
  id: string;
  name: string;
  tagline?: string;
  category?: string;
  version: string;
  author?: string;
  license?: string;
  icon?: string;
  screenshots?: string[];
  description?: string;
  settings?: SettingField[];
  ports?: PortSpec[];
  /** Raw docker-compose.yml text for this app (with ${SETTING} placeholders). */
  compose: string;
}

/** Persisted per-app metadata (APPS_DIR/<id>/meta.json). */
export interface AppMeta {
  id: string;
  name: string;
  kind: 'catalog' | 'community' | 'custom';
  icon?: string;
  category?: string;
  version?: string;
  createdAt: string;
}

/** What the dashboard sees for each installed app. */
export interface InstalledApp {
  id: string;
  name: string;
  kind: 'catalog' | 'community' | 'custom';
  icon?: string;
  category?: string;
  running: boolean;
  ports: number[];
  createdAt: string;
}
