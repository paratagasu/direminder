// 定期実行の登録
import { client } from './client.js';
import { db } from './db.js';
import { GUILD_ID } from './config.js';
import { registerCron, clearAllJobs } from './cron.js';
import { sendMorningSummary, scheduleEventReminders } from './features/events.js';
import { syncAllEventsToCalendar } from './calendar.js';
import { restoreSaylaterJobs, restoreRepeatJobs } from './features/saylater.js';
import { sendMonthlyAwards } from './gj.js';

export function bootstrapSchedules() {
  clearAllJobs();
  const [h, m] = (db.data.morningTime || '07:00').split(':');
  registerCron(`0 ${Number(m)} ${Number(h)} * * *`, () => sendMorningSummary(true), 'morning-summary');
  registerCron('0 0 * * *', scheduleEventReminders, 'daily-reschedule');
  scheduleEventReminders().catch(e => console.error('イベントcron登録エラー:', e.message));
  // 3分おきにCalendar同期
  registerCron('*/3 * * * *', syncAllEventsToCalendar, 'calendar-sync');
  // 1分おきにイベント状態を再確認してcronを更新
  registerCron('* * * * *', async () => {
    try { await scheduleEventReminders(); }
    catch (e) { console.error('イベント再認識エラー:', e.message); }
  }, 'event-resync');
  // 伝言予約ジョブを復元
  restoreSaylaterJobs();
  restoreRepeatJobs();
  // 月間表彰（毎月末日23:59）
  registerCron('59 23 L * *', () => sendMonthlyAwards(db, client, GUILD_ID), 'monthly-awards');
}
