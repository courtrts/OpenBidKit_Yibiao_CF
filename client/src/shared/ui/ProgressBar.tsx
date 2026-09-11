import type { CSSProperties } from 'react';

export type ProgressBarTone = 'primary' | 'success' | 'warning' | 'danger' | 'sky' | 'violet';

export interface ProgressBarProps {
  /** 进度百分比 0-100，组件内部会自动夹取范围 */
  value: number;
  /** 无障碍描述，例如“解析进度 40%” */
  label?: string;
  /** 颜色语义：默认主色，规划=success、字数调整=warning、失败=danger、审计=sky、图片编排=violet */
  tone?: ProgressBarTone;
  /** 任务进行中时显示扫光动效 */
  active?: boolean;
  /** 进度未知（排队中/尚未上报）时显示流动条纹，读屏不再误报 "0%" */
  indeterminate?: boolean;
  className?: string;
}

/** 统一进度条：单一 track + --progress CSS 变量控制宽度，替代各功能自建的进度条实现。
 * 根元素使用 span，保证放进 Tab 等 button 内部时仍是合法 HTML。 */
export default function ProgressBar({
  value,
  label,
  tone = 'primary',
  active = false,
  indeterminate = false,
  className,
}: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <span
      className={`yb-progress-track${tone !== 'primary' ? ` is-${tone}` : ''}${active ? ' is-active' : ''}${indeterminate ? ' is-indeterminate' : ''}${className ? ` ${className}` : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(indeterminate ? {} : { 'aria-valuenow': clamped })}
      style={{ '--progress': `${clamped}%` } as CSSProperties}
    >
      <span />
    </span>
  );
}
