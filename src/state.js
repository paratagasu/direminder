// Botの全状態のエクスポート・インポート
import { db, normalizeData } from './db.js';
import { initGjData } from './gj.js';
import { BOT_VERSION } from './config.js';

// エクスポート対象（配列で持つ項目は配列であることを確認してから取り込む）
const ARRAY_KEYS  = ['reminderOffsets', 'lastReminderMsgIds', 'vcExcludeUsers', 'members'];
const OBJECT_KEYS = ['eventMap', 'eventRoles', 'reminderMsgMap', 'activeVcSessions', 'pendingDeleteSessions',
                     'saylaterJobs', 'repeatJobs', 'attendance', 'gjData', 'channelSnapshot'];
const STRING_KEYS = ['morningTime', 'lastMorningDate'];

export function buildStateExport() {
  const state = { exportedAt: new Date().toISOString(), version: BOT_VERSION, savedAt: db.data.savedAt };
  for (const k of [...STRING_KEYS, ...ARRAY_KEYS, ...OBJECT_KEYS]) state[k] = db.data[k];
  return state;
}

// エクスポートしたJSONを取り込む。ファイルに無い項目は現在の値を残す
export async function applyState(json) {
  if (!json?.version || !json?.exportedAt) throw new Error('正しいエクスポートファイルではありません');
  for (const k of STRING_KEYS) if (typeof json[k] === 'string') db.data[k] = json[k];
  for (const k of ARRAY_KEYS)  if (Array.isArray(json[k])) db.data[k] = json[k];
  for (const k of OBJECT_KEYS) if (json[k] && typeof json[k] === 'object' && !Array.isArray(json[k])) db.data[k] = json[k];
  normalizeData(db.data);
  initGjData(db);
  await db.write();
}

export function summarizeState(json) {
  return [
    `　イベント記録: ${Object.keys(json.eventMap ?? {}).length}件`,
    `　ロール記録: ${Object.keys(json.eventRoles ?? {}).length}件`,
    `　リマインドメッセージ: ${(json.lastReminderMsgIds ?? []).length}件`,
    `　除外ユーザー: ${(json.vcExcludeUsers ?? []).length}名`,
    `　GJ履歴: ${(json.gjData?.history ?? []).length}件`,
    `　伝言予約: ${Object.keys(json.saylaterJobs ?? {}).length}件 / 定期: ${Object.keys(json.repeatJobs ?? {}).length}件`,
    `　メンバー: ${Array.isArray(json.members) ? `${json.members.length}名` : '（ファイルに無いため現在の設定を維持）'}`,
  ].join('\n');
}
