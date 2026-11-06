// タスク管理アプリ連携：イベントが完了したら「議事録作成」のタスクを作ってもらう
// TASKAPP_URL（アプリの公開URL）と TASKAPP_SECRET（アプリの DISCORD_TASK_SECRET と同じ値）が無ければ何もしない
import { GUILD_ID, TASKAPP_URL, TASKAPP_SECRET } from './config.js';

async function post(body) {
  const res = await fetch(`${TASKAPP_URL.replace(/\/+$/, '')}/api/internal/discord-event`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TASKAPP_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000), // アプリが寝ていると起きるまで少しかかる
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${data.message ?? ''}`);
  return data;
}

export async function requestMinutesTask(e) {
  if (!TASKAPP_URL || !TASKAPP_SECRET) return;
  const body = {
    eventId: e.id,
    name: e.name,
    url: `https://discord.com/events/${GUILD_ID}/${e.id}`,
    startAt: new Date(e.scheduledStartTimestamp).toISOString(),
  };
  // 失敗したら1分後にもう1回だけ（アプリ側で同じ回は2回作らないので、重複はしない）
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await post(body);
      console.log(r.created ? `📝 議事録タスク作成: "${e.name}"` : `📝 議事録タスクは作成済み: "${e.name}"`);
      return;
    } catch (err) {
      console.error(`❌ 議事録タスク作成失敗（${attempt}回目）: "${e.name}"`, err.message);
      if (attempt === 1) await new Promise(r => setTimeout(r, 60_000));
    }
  }
}
