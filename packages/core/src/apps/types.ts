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
   * Opt in to OpenMasjidOS Fabric single sign-on. When true, the platform issues
   * this app a per-app secret at install (injected as OPENMASJID_APP_SECRET) and only
   * then will honour the app's calls to GET /api/auth/session. Apps that don't
   * set this can't introspect the dashboard session — least privilege.
   */
  sso?: boolean;
  /**
   * Opt in to OpenMasjidOS Fabric notifications. When true, the platform issues
   * this app the per-app secret and the app may POST /api/fabric/notify to relay
   * messages to the admin's configured webhook (Slack/Discord/generic).
   */
  notifications?: boolean;
  /**
   * A teaser entry for an app that isn't released yet. Coming-soon apps have no
   * repo/compose; the App Store shows them with a "Coming soon" badge and no
   * install action, and the platform refuses to install them.
   */
  comingSoon?: boolean;
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
  /** True if this app opted into Fabric notifications (CatalogApp.notifications). */
  notify?: boolean;
  /**
   * Per-app Fabric secret (random, base64url), issued when the app opts into any
   * Fabric capability (sso and/or notifications). The app presents it in the
   * X-OpenMasjid-App-Secret header to prove which app is asking. Server-side only
   * — never included in the InstalledApp DTO sent to the dashboard.
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
