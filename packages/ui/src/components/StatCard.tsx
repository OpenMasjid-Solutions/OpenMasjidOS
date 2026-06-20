import { memo, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { staggerItem } from '../lib/motion';

interface StatCardProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** 0–100; renders a gauge bar when provided. */
  percent?: number;
  icon?: ReactNode;
  /** Tint the gauge as a warning (e.g. nearly-full disk). */
  warn?: boolean;
}

// Memoized so the ~2s live-stats tick only re-renders cards whose value
// actually changed (CPU/RAM), not the steady ones (temp/uptime/apps).
export const StatCard = memo(function StatCard({ label, value, sub, percent, icon, warn }: StatCardProps) {
  return (
    <motion.div className="stat-card glass fx-glint" variants={staggerItem}>
      <div className="stat-label">
        {icon}
        <span>{label}</span>
      </div>
      <div className="stat-value">
        {value} {sub && <small>{sub}</small>}
      </div>
      {percent != null && (
        <div className="gauge-track" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
          <div className={`gauge-fill${warn ? ' gauge-fill--warn' : ''}`} style={{ width: `${Math.max(2, Math.min(100, percent))}%` }} />
        </div>
      )}
    </motion.div>
  );
});
