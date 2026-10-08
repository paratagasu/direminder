// cron 管理
import cron from 'node-cron';

// desc → { task, expr, fn }
export const jobMap = new Map();

export function stopJob(desc) {
  const entry = jobMap.get(desc);
  if (!entry) return;
  entry.task.stop();
  entry.task.destroy?.();
  jobMap.delete(desc);
}

export function registerCron(expr, jobFn, desc) {
  const current = jobMap.get(desc);
  // 同じ時刻で登録済みなら作り直さない（作り直しの瞬間に発火を取りこぼすのを防ぐ）
  if (current && current.expr === expr) { current.fn = jobFn; return; }
  if (current) stopJob(desc);
  console.log(`⏰ Register cron [${expr}] for ${desc}`);
  const entry = { expr, fn: jobFn, task: null };
  entry.task = cron.schedule(expr, async () => {
    console.log(`▶ Trigger [${desc}] at ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);
    try { await entry.fn(); } catch (e) { console.error(`❌ Job error (${desc}):`, e); }
  }, { timezone: 'Asia/Tokyo' });
  jobMap.set(desc, entry);
}

export function clearAllJobs() { for (const desc of [...jobMap.keys()]) stopJob(desc); }

export function clearJobsWithPrefix(prefix) {
  for (const desc of [...jobMap.keys()]) if (desc.startsWith(prefix)) stopJob(desc);
}
