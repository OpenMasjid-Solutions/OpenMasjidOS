/**
 * Shown before installing a 3rd-party app when one of its web-UI ports is
 * already in use. Lets the user pick a free port for each conflict; the chosen
 * mapping (oldHostPort → newHostPort) is sent to the installer, which rewrites
 * the compose before starting the app.
 */
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';

export interface PortConflict {
  hostPort: number;
  service: string;
  suggestion: number;
}

export function PortConflicts({
  conflicts,
  remap,
  onChange,
}: {
  conflicts: PortConflict[];
  remap: Record<string, number>;
  onChange: (remap: Record<string, number>) => void;
}) {
  const { t } = useTranslation();
  if (conflicts.length === 0) return null;

  return (
    <div className="glass-inset panel" style={{ marginBottom: '1rem' }}>
      <strong style={{ color: 'var(--color-warning)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <AlertTriangle size={16} /> {t('ports.title')}
      </strong>
      <p style={{ marginBlock: '0.4rem 0.7rem' }}>{t('ports.body')}</p>
      {conflicts.map((c) => (
        <div key={c.hostPort} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--color-ink-muted)' }}>{t('ports.inUse', { port: c.hostPort })}</span>
          <span aria-hidden="true">→</span>
          <input
            type="number"
            min={1}
            max={65535}
            className="input glass-inset"
            style={{ width: '7rem' }}
            aria-label={t('ports.newPort', { port: c.hostPort })}
            value={remap[String(c.hostPort)] ?? c.suggestion}
            onChange={(e) => onChange({ ...remap, [String(c.hostPort)]: Number(e.target.value) })}
          />
        </div>
      ))}
    </div>
  );
}

/** Build the initial remap (each conflict → its suggested free port). */
export function initialRemap(conflicts: PortConflict[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of conflicts) out[String(c.hostPort)] = c.suggestion;
  return out;
}
