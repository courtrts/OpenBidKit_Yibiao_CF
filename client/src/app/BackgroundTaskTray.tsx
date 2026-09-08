import { useCallback, useEffect, useState } from 'react';
import type { TaskEventTask } from '../shared/types/ipc';
import type { SectionId } from '../shared/types/navigation';

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

interface BackgroundTaskTrayProps {
  onSectionChange: (section: SectionId) => void;
}

// 后台任务托盘：应用重启后、离开页面时，进行中和已暂停（可继续）的任务
// 在这里持续可见，点击直达对应板块；全部完成后自动收起不占位。
function BackgroundTaskTray({ onSectionChange }: BackgroundTaskTrayProps) {
  const [tasks, setTasks] = useState<TaskEventTask[]>([]);

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
    const unsubscribe = window.yibiao.tasks.onTaskEvent(() => {
      // 任务数量有限，事件触发时整体刷新比增量维护更稳
      refresh();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
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
        const progress = Math.max(0, Math.min(100, Math.round(Number(task.progress) || 0)));
        const label = TASK_LABEL_BY_TYPE[task.type] || task.type;
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
                  : `${progress}%`}
              </span>
            </span>
            <span className="background-task-item-action">查看</span>
          </button>
        );
      })}
    </aside>
  );
}

export default BackgroundTaskTray;
