/**
 * Strict app-id validation. App ids become filesystem path segments
 * (APPS_DIR/<id>/…) and compose project names (omos-<id>), so they must never
 * contain path separators, dots, or anything that could escape the apps dir.
 * Catalog/custom/community ids are all kebab-case, so this allowlist fits them
 * all. See the security audit (path-traversal findings).
 */
export const APP_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function isValidAppId(id: string): boolean {
  return APP_ID_RE.test(id);
}
