// タスク管理アプリ連携：イベントが完了したら「議事録作成」のタスクを作ってもらう
// TASKAPP_URL（アプリの公開URL）と TASKAPP_SECRET（アプリの DISCORD_TASK_SECRET と同じ値）が無ければ何もしない
import { client } from './client.js';
import { db } from './db.js';
import { GUILD_ID, ANNOUNCE_CHANNEL_ID, TASKAPP_URL, TASKAPP_SECRET } from './config.js';

// 設定値に説明の文などが混ざっていても、URLの部分だけを使う
const baseUrl = () => (TASKAPP_URL.match(/https?:\/\/[^\s<>]+/)?.[0] ?? TASKAPP_URL.trim()).replace(/\/+$/, '');

async function post(body) {
  const res = await fetch(`${baseUrl()}/api/internal/discord-event`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TASKAPP_SECRET.trim()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000), // アプリが寝ていると起きるまで少しかかる
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${data.message ?? ''}`);
  return data;
}

export const taskappEnabled = !!(TASKAPP_URL && TASKAPP_SECRET);
export const taskappUrl = TASKAPP_URL ? baseUrl() : null;

// Botが開催（開始・終了）を追跡できる会場か。
// VC・ステージのイベントは追跡できるが、場所指定（サーバー外）のイベントは
// 主催者が開始・終了を押さないことが多く、開催したかどうかが分からない
export function isTrackable(e) {
  return !!e.channelId;
}

// startTs: 開催した回の開始時刻（繰り返しイベントは、終わった時点で次の回の時刻になっているため別に渡す）
// 戻り値: 'created'（作成した）| 'exists'（作成済みだった）| 'failed'（失敗）| 'skipped'（連携なし・サーバー外のイベント）
export async function requestMinutesTask(e, startTs = e.scheduledStartTimestamp) {
  if (!taskappEnabled) return 'skipped';
  // 追跡できない会場のイベントは、開始時に手動作成をお願いしているので自動では作らない（二重作成を防ぐ）
  if (!isTrackable(e)) { console.log(`📝 議事録タスクは手動作成の対象（サーバー外のイベント）: "${e.name}"`); return 'skipped'; }
  const body = {
    eventId: e.id,
    name: e.name,
    url: `https://discord.com/events/${GUILD_ID}/${e.id}`,
    startAt: new Date(startTs).toISOString(),
  };
  // 失敗したら1分後にもう1回だけ（アプリ側で同じ回は2回作らないので、重複はしない）
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await post(body);
      console.log(r.created ? `📝 議事録タスク作成: "${e.name}"` : `📝 議事録タスクは作成済み: "${e.name}"`);
      if (r.created && r.taskUrl) await announceTask(e, startTs, r.taskUrl);
      return r.created ? 'created' : 'exists';
    } catch (err) {
      console.error(`❌ 議事録タスク作成失敗（${attempt}回目）: "${e.name}"`, err.message);
      if (attempt === 1) await new Promise(r => setTimeout(r, 60_000));
    }
  }
  return 'failed';
}

// 「タスク管理ツール」をアプリへのリンクにした文字列（<> で囲んでプレビューを出さない）
export function taskappLink(label = 'タスク管理ツール') {
  return taskappUrl ? `[${label}](<${taskappUrl}>)` : label;
}

// 議事録タスクの結果を、会議お疲れメッセージに添える1行
export function minutesResultLine(result) {
  if (result === 'created' || result === 'exists') return `📝 俺の方から${taskappLink()}に議事録作成のタスクを作成しておいたぜ！`;
  if (result === 'failed') return '⚠️ 議事録作成タスクの連携は何らかの理由で失敗したぜ！';
  return null;
}

// 作ったタスクへのリンクを送る（出欠カードのチャンネル、なければリマインドのチャンネル）
async function announceTask(e, startTs, taskUrl) {
  try {
    const channelId = db.data.attendance?.[e.id]?.channelId ?? ANNOUNCE_CHANNEL_ID;
    const ch = await client.channels.fetch(channelId);
    const day = new Date(startTs).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' });
    const label = `${e.name}（${day}）`.replace(/[\[\]]/g, '');
    // [文字](<URL>) … 文字がリンクになり、URLのプレビューは出さない
    await ch.send({ content: `📝 議事録作成のタスクはここに用意しておいたぜ！ → [${label}](<${taskUrl}>)`, allowedMentions: { parse: [] } });
  } catch (err) {
    console.error(`❌ 議事録タスクのリンク送信失敗: "${e.name}"`, err.message);
  }
}
