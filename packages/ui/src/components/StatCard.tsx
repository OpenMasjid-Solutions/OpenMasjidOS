import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { staggerItem } from '../lib/motion';

interface StatCardProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** 0–100; renders a gauge bar when provided. */
  percent?: number;
  icon?: ReactNode;
}

export function StatCard({ label, value, sub, percent, icon }: StatCardProps) {
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
          <div className="gauge-fill" style={{ width: `${Math.max(2, Math.min(100, percent))}%` }} />
        </div>
      )}
    </motion.div>
  );
}
