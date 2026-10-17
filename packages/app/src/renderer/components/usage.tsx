import type { ResourceUsage } from '@abox/core';
import { useT } from '../context';
import { formatCpuPercent, formatMemoryUsage, usageFraction } from '../../shared/format';

/**
 * Live cpu and memory of a running sandbox: numbers first (the bars only repeat them, so they are hidden
 * from assistive technology). `cpus` / `memoryBytes` are the configured limits the bars are measured against.
 */
export function UsageLines(props: { usage: ResourceUsage; cpus: number; memoryBytes: number }) {
  const t = useT();
  const { usage: u } = props;
  const cpuMax = props.cpus > 0 ? props.cpus * 100 : 100;
  const memMax = u.memoryLimitBytes ?? props.memoryBytes;
  return (
    <div className="usage" data-testid="usage">
      <div className="usage-row">
        <span className="usage-label">{t('usage.cpu')}</span>
        <span className="mono">{formatCpuPercent(u.cpuPercent)}</span>
        <span className="usage-bar" aria-hidden="true">
          <span style={{ width: `${Math.round(usageFraction(u.cpuPercent, cpuMax) * 100)}%` }} />
        </span>
      </div>
      <div className="usage-row">
        <span className="usage-label">{t('usage.ram')}</span>
        <span className="mono">
          {formatMemoryUsage(u.memoryBytes, u.memoryLimitBytes, props.memoryBytes)}
        </span>
        <span className="usage-bar" aria-hidden="true">
          <span style={{ width: `${Math.round(usageFraction(u.memoryBytes, memMax) * 100)}%` }} />
        </span>
      </div>
      {u.pids !== null ? (
        <div className="usage-row">
          <span className="usage-label">{t('usage.pids')}</span>
          <span className="mono">{u.pids}</span>
        </div>
      ) : null}
    </div>
  );
}
