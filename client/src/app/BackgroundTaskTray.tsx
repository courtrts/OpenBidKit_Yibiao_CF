import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskEventTask } from '../shared/types/ipc';
import type { SectionId } from '../shared/types/navigation';
import { formatDuration } from '../shared/utils/duration';

// 任务类型 → 所在板块。与主进程 taskService 的 taskDefinitions.group 保持一致；
// 未知类型兜底到技术方案（绝大多数任务属于该流程），避免静默丢失。
const TASK_SECTION_BY_TYPE: Record<string, SectionId> = {
  'bid-section-extraction': 'technical-plan',
  'bid-analysis': 'technical-plan',
  'outline-generation': 'technical-plan',
  'outline-adjustment': 'technical-plan',
  'global-facts-generation': 'technical-plan',
  'global-facts-adjustment': 'technical-plan',
  'content-generation': 'technical-plan',
  'rejection-items-extraction': 'rejection-check',
  'rejection-check-run': 'rejection-check',
  'duplicate-analysis': 'duplicate-check',
  'feasibility-analysis': 'feasibility-report',
  'feasibility-outline': 'feasibility-report',
  'feasibility-outline-adjustment': 'feasibility-report',
  'feasibility-parameters': 'feasibility-report',
  'feasibility-content': 'feasibility-report',
  'feasibility-human-writing': 'feasibility-report',
};

const TASK_LABEL_BY_TYPE: Record<string, string> = {
  'bid-section-extraction': '多标段识别',
  'bid-analysis': '招标文件解析',
  'outline-generation': '目录生成',
  'outline-adjustment': '目录AI调整',
  'global-facts-generation': '全局事实设定',
  'global-facts-adjustment': '全局事实AI调整',
  'content-generation': '正文生成',
  'rejection-items-extraction': '无效与废标项解析',
  'rejection-check-run': '废标项检查',
  'duplicate-analysis': '标书查重分析',
  'feasibility-analysis': '可研项目资料分析',
  'feasibility-outline': '可研报告目录生成',
  'feasibility-outline-adjustment': '可研报告目录AI调整',
  'feasibility-parameters': '可研关键参数生成',
  'feasibility-content': '可研报告正文生成',
  'feasibility-human-writing': '可研自然化审校',
};

const TRAY_STATUSES = new Set(['running', 'pausing', 'paused']);
// 主进程提供暂停能力的三类任务（自然化审校与正文生成共用 pauseFeasibilityContent）；
// 其余任务尚无取消/暂停 IPC，不显示暂停按钮
const PAUSABLE_TASK_TYPES = new Set(['content-generation', 'feasibility-content', 'feasibility-human-writing']);
const TERMINAL_NOTIFICATION_STATUSES = new Set(['success', 'error']);

interface BackgroundTaskTrayProps {
  onSectionChange: (section: SectionId) => void;
}

// 后台任务托盘：应用重启后、离开页面时，进行中和已暂停（可继续）的任务
// 在这里持续可见，点击直达对应板块；全部完成后自动收起不占位。
// 任务到达终态时发系统通知（点击直达），长任务等待不再依赖用户手动回看。
function BackgroundTaskTray({ onSectionChange }: BackgroundTaskTrayProps) {
  const [tasks, setTasks] = useState<TaskEventTask[]>([]);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const notifiedRef = useRef(new Set<string>());

  const formatElapsed = (startedAt: string, nowMs: number) => {
    const startedMs = Date.parse(startedAt);
    if (!Number.isFinite(startedMs)) return '';
    return formatDuration(nowMs - startedMs);
  };

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      window.yibiao.tasks
        .getActiveTasks()
        .then((list) => {
          if (cancelled) return;
          setTasks(
            (Array.isArray(list) ? list : []).filter((task) => TRAY_STATUSES.has(task?.status)),
          );
        })
        .catch(() => {
          // 任务读取失败不影响主界面
        });
    };

    refresh();
    // 任务数量有限，事件触发时整体刷新比增量维护更稳；生成期间事件频率很高，
    // 用 300ms 尾沿合并，避免每个事件都发起一次 get-active 往返。
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refresh();
      }, 300);
    };

    // 终态去重：同一任务的同一终态只通知一次（事件可能因重试/快照重放多次到达）
    const notifyIfTerminal = (task: TaskEventTask) => {
      if (!TERMINAL_NOTIFICATION_STATUSES.has(task.status)) return;
      const dedupeKey = `${task.task_id}:${task.status}`;
      if (notifiedRef.current.has(dedupeKey)) return;
      notifiedRef.current.add(dedupeKey);
      const label = TASK_LABEL_BY_TYPE[task.type] || task.type;
      const finished = task.status === 'success';
      try {
        const notification = new Notification(finished ? `${label}已完成` : `${label}失败`, {
          body: finished ? '点击查看结果' : String(task.error || '点击查看详情').slice(0, 120),
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
          onSectionChange(TASK_SECTION_BY_TYPE[task.type] || 'technical-plan');
        };
      } catch {
        // 系统通知不可用时静默跳过，不影响主流程
      }
    };

    const unsubscribe = window.yibiao.tasks.onTaskEvent((event) => {
      const task = (event as { task?: TaskEventTask } | null)?.task;
      if (task) notifyIfTerminal(task);
      scheduleRefresh();
    });
    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, [onSectionChange]);

  // 有运行中任务时每秒走表，驱动“已运行时长”显示
  const hasRunning = tasks.some((task) => task.status === 'running');
  useEffect(() => {
    if (!hasRunning) return undefined;
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRunning]);

  const pauseTask = useCallback((task: TaskEventTask) => {
    // 发射后不管的请求也要兜住 rejection：暂停失败任务保持运行，托盘状态不会说谎
    const fail = () => console.warn('[background-task-tray] 暂停请求失败');
    window.yibiao.tasks.pauseFeasibilityContent().catch(fail);
  }, []);

  const jumpToTask = useCallback(
    (task: TaskEventTask) => {
      onSectionChange(TASK_SECTION_BY_TYPE[task.type] || 'technical-plan');
    },
    [onSectionChange],
  );

  if (!tasks.length) return null;

  return (
    <aside className="background-task-tray" aria-label="进行中的任务">
      {tasks.map((task) => {
        const paused = task.status === 'paused' || task.status === 'pausing';
        const running = task.status === 'running';
        const pausable = running && PAUSABLE_TASK_TYPES.has(task.type);
        const progress = Math.max(0, Math.min(100, Math.round(Number(task.progress) || 0)));
        const label = TASK_LABEL_BY_TYPE[task.type] || task.type;
        const elapsed = running ? formatElapsed(task.started_at, nowTick) : '';
        return (
          <button
            key={task.task_id}
            type="button"
            className={`background-task-item${paused ? ' is-paused' : ''}`}
            onClick={() => jumpToTask(task)}
            aria-label={`跳转到${label}任务`}
          >
            <span className={`background-task-dot${paused ? ' is-paused' : ''}`} aria-hidden />
            <span className="background-task-item-copy">
              <strong>{label}</strong>
              <span>
                {paused
                  ? '已暂停，可继续'
                  : `${progress}%${elapsed ? ` · 已运行 ${elapsed}` : ''}`}
              </span>
            </span>
            {pausable ? (
              <span
                className="background-task-item-action background-task-item-pause"
                role="button"
                tabIndex={0}
                aria-label={`暂停${label}任务`}
                onClick={(event) => {
                  event.stopPropagation();
                  pauseTask(task);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    pauseTask(task);
                  }
                }}
              >
                暂停
              </span>
            ) : (
              <span className="background-task-item-action">查看</span>
            )}
          </button>
        );
      })}
    </aside>
  );
}

export default BackgroundTaskTray;
