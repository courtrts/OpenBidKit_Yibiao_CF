-- 部署切换窗口 Cloudflare 可能把同一个 cron 事件投递给新旧两个 Worker 版本，
-- 两次并行的每日汇总会在对方分块成功标记落库前各自提交同一批递增语句，
-- 使 total_events 等累计计数器双计（分块级幂等标记只防串行重跑，不防并发双跑）。
-- 命名租约表：scheduled() 入口原子"插入或接管过期租约"，第二个调用方抢不到即跳过汇总步骤；
-- 租约不显式释放，靠过期时间窗自然失效（宕机不阻塞次日 cron 接管，接管前旧锁已过期 30 分钟以上）。
CREATE TABLE IF NOT EXISTS stats_scheduled_locks (
  lock_name TEXT PRIMARY KEY,
  acquired_at TEXT NOT NULL,
  acquired_token TEXT NOT NULL
);
