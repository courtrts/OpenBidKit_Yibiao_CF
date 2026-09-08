-- 高频查询以 activity_date 为前导过滤（queryCompletedStages/listRollupRuns/
-- catch-up 扫描），而两表的复合主键都以 project_name 为前导列，无法命中；
-- agent_error_logs 清理查询的 expires_at <= ? 臂同样无前导匹配索引。
-- 三个补丁索引消除 cron 内每天必跑的全表扫描。
CREATE INDEX IF NOT EXISTS idx_rollup_runs_activity_date
ON stats_rollup_runs (activity_date);

CREATE INDEX IF NOT EXISTS idx_rollup_stages_activity_date
ON stats_rollup_stages (activity_date);

CREATE INDEX IF NOT EXISTS idx_agent_error_logs_expires_at
ON agent_error_logs (expires_at);
