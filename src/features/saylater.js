// 伝言予約（1回きり・定期）
import { client } from '../client.js';
import { db } from '../db.js';
import { registerCron, stopJob, jobMap, clearJobsWithPrefix } from '../cron.js';
import { cronExprAt, formatHHMM, WEEKDAYS, formatJst } from '../time.js';

// ============================================================
// 1回きりの伝言予約
// ============================================================
async function sendSaylater(job) {
  const ch = await client.channels.fetch(job.channelId);
  await ch.send(`<@${job.mentionId}>\n${job.message}`);
}

// 伝言予約1件をcronに登録（新規作成・復元の共通処理）
export function scheduleSaylaterJob(id) {
  const job = db.data.saylaterJobs[id];
  if (!job) return;
  const desc = `simple-remind:${id}`;
  registerCron(cronExprAt(new Date(job.fireAt)), async () => {
    try { await sendSaylater(job); }
    catch (e) { console.error('❌ 伝言予約送信失敗:', e.message); }
    delete db.data.saylaterJobs[id];
    await db.write();
    stopJob(desc);
  }, desc);
}

export function restoreSaylaterJobs() {
  const now = Date.now();
  for (const [id, job] of Object.entries(db.data.saylaterJobs ?? {})) {
    if (new Date(job.fireAt).getTime() <= now) {
      // 停止中に過ぎた予約は即時送信
      sendSaylater(job).catch(e => console.error('❌ 伝言予約送信失敗:', e.message));
      delete db.data.saylaterJobs[id];
      db.write().catch(() => {});
      continue;
    }
    scheduleSaylaterJob(id);
  }
}

// ============================================================
// 定期伝言予約
// ============================================================
// db.data.repeatJobs[id] = { freq, hour, minute, weekday, day, message, mentionId, roleId, channelId, createdBy, paused, createdAt }
export const REPEAT_FREQS = {
  daily:          '毎日',
  weekdays:       '平日（月〜金）',
  weekly:         '毎週',
  monthly:        '毎月（日付指定）',
  'monthly-last': '毎月末',
};
const REPEAT_PREFIX = 'repeat:';

export function repeatCronExpr(job) {
  const base = `${job.minute} ${job.hour}`;
  switch (job.freq) {
    case 'daily':        return `${base} * * *`;
    case 'weekdays':     return `${base} * * 1-5`;
    case 'weekly':       return `${base} * * ${job.weekday}`;
    case 'monthly':      return `${base} ${job.day} * *`;
    case 'monthly-last': return `${base} L * *`;
    default: throw new Error(`不明な頻度: ${job.freq}`);
  }
}

export function describeRepeat(job) {
  const t = formatHHMM(job.hour, job.minute);
  switch (job.freq) {
    case 'daily':        return `毎日 ${t}`;
    case 'weekdays':     return `平日 ${t}`;
    case 'weekly':       return `毎週${WEEKDAYS[job.weekday]}曜 ${t}`;
    case 'monthly':      return `毎月${job.day}日 ${t}`;
    case 'monthly-last': return `毎月末 ${t}`;
    default: return '不明';
  }
}

export function repeatNextRun(id) {
  const next = jobMap.get(`${REPEAT_PREFIX}${id}`)?.task?.getNextRun?.();
  return next ? formatJst(next, { month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit' }) : null;
}

export async function sendRepeat(job) {
  const ch = await client.channels.fetch(job.channelId);
  const mentions = [job.mentionId && `<@${job.mentionId}>`, job.roleId && `<@&${job.roleId}>`].filter(Boolean).join(' ');
  await ch.send({
    content: `${mentions ? mentions + '\n' : ''}🔁 ${job.message}`,
    allowedMentions: { users: job.mentionId ? [job.mentionId] : [], roles: job.roleId ? [job.roleId] : [] },
  });
}

export function scheduleRepeatJob(id) {
  const desc = `${REPEAT_PREFIX}${id}`;
  const job = db.data.repeatJobs[id];
  if (!job || job.paused) { stopJob(desc); return; }
  registerCron(repeatCronExpr(job), async () => {
    const current = db.data.repeatJobs[id];
    if (!current || current.paused) return;
    await sendRepeat(current);
  }, desc);
}

export function restoreRepeatJobs() {
  clearJobsWithPrefix(REPEAT_PREFIX);
  for (const id of Object.keys(db.data.repeatJobs ?? {})) {
    try { scheduleRepeatJob(id); } catch (e) { console.error(`定期伝言予約の登録失敗 (${id}):`, e.message); }
  }
}

// 作成順に並べた一覧（番号指定のコマンド用）
export function repeatJobList() {
  return Object.entries(db.data.repeatJobs ?? {}).sort((a, b) => (a[1].createdAt ?? '').localeCompare(b[1].createdAt ?? ''));
}
