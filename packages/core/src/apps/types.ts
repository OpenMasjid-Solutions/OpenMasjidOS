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
  /**
   * Opt in to OpenMasjidOS single sign-on. When true, the platform issues this
   * app a per-app secret at install (injected as OPENMASJID_APP_SECRET) and only
   * then will honour the app's calls to GET /api/auth/session. Apps that don't
   * set this can't introspect the dashboard session — least privilege.
   */
  sso?: boolean;
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
  /** True if this app opted into single sign-on (CatalogApp.sso). */
  sso?: boolean;
  /**
   * Per-app SSO secret (random, base64url). The app presents it back to
   * GET /api/auth/session to prove which app is asking. Server-side only —
   * never included in the InstalledApp DTO sent to the dashboard.
   */
  ssoSecret?: string;
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
