-- /api/clients 列表页按 (project_name, last_active_date DESC, first_seen_at DESC, client_id)
-- 排序；stats_clients 是库中最大表，旧索引 (project_name, last_active_date) 缺第二排序键
-- 导致每页全分区物化排序。新复合索引让 SQLite 反向扫描直接满足排序、LIMIT 早停。
-- （排序 tiebreaker 同步调整为 client_id，见 analyticsStatsStore.queryClientsPage）
CREATE INDEX IF NOT EXISTS idx_stats_clients_project_active_client
ON stats_clients (project_name, last_active_date, client_id);
