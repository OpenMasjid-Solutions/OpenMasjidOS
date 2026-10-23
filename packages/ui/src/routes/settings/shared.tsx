// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useId, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/** A small red/green/grey status dot. `online` undefined = unknown (grey). */
export function StatusDot({ online, label: override }: { online: boolean | undefined; label?: string }) {
  const { t } = useTranslation();
  const color = online === undefined ? 'var(--color-ink-muted)' : online ? '#22c55e' : '#ef4444';
  // `override` exists for states that are not simply up or down. "Connected, but the
  // gateway has sent nothing" is red because the feature does not work — but calling
  // it "Offline" sends the admin to check a connection that is fine.
  const label =
    override ?? (online === undefined ? t('settings.statusChecking') : online ? t('settings.statusOnline') : t('settings.statusOffline'));
  return (
    <span
      title={label}
      aria-label={label}
      role="img"
      style={{
        display: 'inline-block',
        width: 9,
        height: 9,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
        boxShadow: online ? '0 0 6px rgba(34,197,94,0.6)' : undefined,
      }}
    />
  );
}

/**
 * A labelled form field whose label is TIED to its control, so a screen reader names
 * the box and a click on the label lands in it. `children` is handed the id to put on
 * the control — the same idea as CheckboxField, for everything that is not a tick.
 */
export function Field({
  label,
  hint,
  style,
  children,
}: {
  label: string;
  hint?: ReactNode;
  style?: CSSProperties;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field" style={style}>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
