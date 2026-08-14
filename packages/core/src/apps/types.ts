// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Shared app/manifest types. The manifest is the contract OpenMasjidAPPS must
 * follow (docs/APP_MANIFEST_SPEC.md). The platform never holds masjid data —
 * an app collects everything it needs through its own `settings` block.
 */

export interface SettingField {
  key: string;
  label: string;
  // `stripe-account` is a platform-aware picker: the OS renders a dropdown of the
  // Stripe accounts the admin configured in Settings → Payments, and passes the
  // chosen account's NAME as this setting's value (the app then fetches its keys
  // via the Fabric). The admin never re-types Stripe details in the install dialog.
  type: 'text' | 'select' | 'number' | 'password' | 'boolean' | 'stripe-account';
  options?: string[];
  default?: string;
}

export interface PortSpec {
  container: number;
  label?: string;
}

/**
 * A catalog entry as published by OpenMasjidAPPS in catalog.json.
 *
 * `version` is the update axis, on BOTH channels. A Stable entry names a release
 * (`0.10.2`) and pins a digest; a Development entry names a semver prerelease
 * (`0.11.0-dev.1`) and pins that exact immutable tag. There was briefly an
 * `imageDigests` map here so the platform could detect a new dev build by comparing
 * registry digests — it existed only because dev entries used to repeat the stable
 * version and point at a moving `:dev` tag, leaving nothing else to compare. Real dev
 * versions replaced it; don't reintroduce a second update axis.
 */
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
   * Opt in to OpenMasjidOS Fabric Stripe. When true, the platform issues this app
   * the per-app secret and the app may GET /api/fabric/stripe?account=<name> to
   * fetch a named Stripe account's keys (publishable + secret + webhook signing
   * secret) that the admin configured ONCE in OS settings. Lets several apps
   * (donations, kiosk…) share one Stripe account without re-entering keys.
   */
  stripe?: boolean;
  /**
   * Opt in to OpenMasjidOS Fabric remote-access info. When true, the platform
   * issues this app the per-app secret and the app may GET /api/fabric/site to
   * learn its PUBLIC URL (the admin's Cloudflare-tunnel domain + the app's path)
   * for building absolute links — Stripe success/cancel URLs, webhook endpoints,
   * QR codes. Returns an empty URL when remote access isn't enabled.
   */
  domain?: boolean;
  /**
   * Require this app to be served over HTTPS. Set ONLY for apps that need a
   * secure context — i.e. apps that use Stripe (the in-person M2 reader / Stripe
   * Terminal SDK and in-page Stripe Elements both require HTTPS). The platform
   * serves such an app on a dedicated HTTPS port (TLS-terminated with the
   * dashboard's cert) and surfaces an https:// Open URL. Non-payment apps should
   * NOT set this — they stay on plain HTTP.
   */
  https?: boolean;
  /**
   * Opt in to the OpenMasjidOS Fabric app-to-app broker. `provides` lists the
   * capabilities this app SERVES (the platform brokers calls to them at
   * `/fabric/<capability>/<method>` on the app's web port); `consumes` lists the
   * capabilities this app may CALL, each as "<target-app-id>/<capability>". Any
   * app with a fabric block is issued the per-app secret (like sso/notifications).
   * Grants are STATIC from the manifest (no admin approval UI in v1); calls are
   * catalog-app↔catalog-app only. See docs/APP_MANIFEST_SPEC.md.
   */
  fabric?: FabricGrants;
  /**
   * Opt into Fabric email. When true, the platform issues the app the per-app secret
   * and the app may POST /api/fabric/email to send email (donation receipts, parent
   * notices, …) via the admin-configured provider (SMTP/Resend) — the app never
   * sees the mail credentials or the From address.
   */
  email?: boolean;
  /**
   * OPTIONAL — may POST /api/fabric/whatsapp to send a WhatsApp message through the
   * masjid's own OpenWA gateway. The platform owns the pacing (see notify/whatsapp.ts):
   * the call QUEUES, it never delivers synchronously, so nothing auth-critical may
   * depend on it.
   */
  whatsapp?: boolean;
  /**
   * Alert types this app can raise (admin gets a granular on/off per alert; all on
   * by default). The app fires one with POST /api/fabric/alert { alert: "<id>", … }.
   */
  alerts?: DeclaredAlert[];
  /**
   * Request to be reachable from the internet through the OS's Cloudflare tunnel.
   * This is only a REQUEST — the admin still confirms exposure at install (and can
   * toggle it later in Settings). When exposed, the app's public URL is delivered
   * as OPENMASJID_PUBLIC_URL (empty when not). Off ⇒ the app stays LAN-only.
   */
  tunnel?: boolean;
  /**
   * A teaser entry for an app that isn't released yet. Coming-soon apps have no
   * repo/compose; the App Store shows them with a "Coming soon" badge and no
   * install action, and the platform refuses to install them.
   */
  comingSoon?: boolean;
  /** Raw docker-compose.yml text for this app (with ${SETTING} placeholders). */
  compose: string;
}

/** A single capability an app serves over the Fabric broker. */
export interface FabricProvide {
  capability: string;
}

/** An alert type an app can raise (manifest `alerts:`). The admin gets a granular
 *  on/off per alert in Settings → Alerts (all on by default). */
export interface DeclaredAlert {
  /** Stable kebab-case id the app passes to POST /api/fabric/alert. */
  id: string;
  /** Short human label for the Settings toggle. */
  label: string;
  /** Optional one-line description of when it fires. */
  description?: string;
}

/** App-to-app broker grants declared in a catalog app's manifest (CatalogApp.fabric). */
export interface FabricGrants {
  /** Capabilities this app serves at /fabric/<capability>/<method> on its web port. */
  provides?: FabricProvide[];
  /** Capabilities this app may call, each "<target-app-id>/<capability>". */
  consumes?: string[];
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
  /** True if this app opted into Fabric Stripe access (CatalogApp.stripe). */
  stripe?: boolean;
  /** True if this app opted into Fabric remote-access info (CatalogApp.domain). */
  domain?: boolean;
  /** Fabric broker capabilities this app SERVES (CatalogApp.fabric.provides). */
  fabricProvides?: string[];
  /** Fabric broker grants this app may CALL, "<target-app-id>/<capability>". */
  fabricConsumes?: string[];
  /** True if this app opted into Fabric email (CatalogApp.email). */
  email?: boolean;
  /** Recorded at install: may this app send WhatsApp over the Fabric? */
  whatsapp?: boolean;
  /** Alert types this app can raise (CatalogApp.alerts) — for the granular toggles. */
  appAlerts?: DeclaredAlert[];
  /** Whether this app is exposed over the Cloudflare tunnel. Admin-controlled
   *  (default from the manifest `tunnel:true` at install; toggleable in Settings).
   *  `undefined` means "installed before per-app exposure existed" — grandfathered
   *  as exposed so upgrades don't silently take a working app offline. */
  exposed?: boolean;
  /** Admin-chosen public path segment for remote access (Cloudflare path + the
   *  Fabric basePath), e.g. "donate". Defaults to the app id when unset. */
  path?: string;
  /** True if this app must be served over HTTPS (Stripe apps — CatalogApp.https). */
  https?: boolean;
  /** The dedicated host port the platform's TLS proxy serves this app on (https). */
  httpsPort?: number;
  /**
   * Per-app Fabric secret (random, base64url), issued when the app opts into any
   * Fabric capability (sso and/or notifications). The app presents it in the
   * X-OpenMasjid-App-Secret header to prove which app is asking. Server-side only
   * — never included in the InstalledApp DTO sent to the dashboard.
   */
  ssoSecret?: string;
  /**
   * Which update channel this app was last installed or updated from
   * (system/channel.ts). `undefined` means it predates channels and is
   * grandfathered as `'main'` — the same way `exposed` grandfathers pre-0.40
   * installs — so upgrading the platform never reports every existing app as
   * needing a channel switch it does not actually need.
   */
  channel?: 'main' | 'dev';
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
  /** True when this app is served over HTTPS (a Stripe app behind the TLS proxy). */
  https: boolean;
  /** The port to open the app on — the HTTPS proxy port if https, else the first
   *  published HTTP port. Null when the app publishes no web port. */
  openPort: number | null;
  /** Whether this app is exposed over the Cloudflare tunnel (admin-controlled).
   *  Grandfathered true for apps installed before per-app exposure existed. */
  exposed: boolean;
  /**
   * True only when this app opted into the OpenMasjidOS Fabric (sso and/or
   * notifications) — i.e. an official catalog app that understands the platform.
   * The dashboard uses this to decide whether to hand off appearance prefs on
   * "Open" (the `#omos=…` fragment). Community/custom apps are always false, so
   * an untrusted 3rd-party app never receives the Fabric payload.
   */
  fabric: boolean;
  /**
   * True for an app the PLATFORM drives rather than the masjid (see `apps/managed.ts`).
   * The dashboard hides these from the grid — they are reached through Settings, because
   * using them directly breaks the invariant the platform is maintaining on their behalf.
   */
  managed: boolean;
}
