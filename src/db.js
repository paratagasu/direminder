// 状態の保存（settings.json）
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { initGjData } from './gj.js';
import { DEFAULT_MEMBERS } from './members.default.js';

const emptyGjData = () => ({ points: {}, history: [], achievements: {}, dailySent: {}, gjChain: null, monthlyCounters: {} });

const defaultData = {
  morningTime: '07:00',
  reminderOffsets: [60, 15],
  eventMap: {},
  eventRoles: {},
  reminderMsgMap: {},
  lastReminderMsgIds: [],
  vcExcludeUsers: [],
  activeVcSessions: {},
  pendingDeleteSessions: {}, // userId → { msgId, events[], calendarId }
  saylaterJobs: {},          // interactionId → { fireAt, message, mentionId, channelId }
  repeatJobs: {},            // id → { freq, time, weekday, day, message, mentionId, channelId, createdBy, paused }
  attendance: {},            // eventId → { yes: [], no: [], msgId, channelId }
  gjData: emptyGjData(),
  channelSnapshot: { savedAt: null, channels: {} },
  savedAt: null,
};

// 古いデータ・インポートしたデータでも必要な項目が揃うようにする
export function normalizeData(data) {
  data.morningTime           ??= '07:00';
  data.eventMap              ??= {};
  data.eventRoles            ??= {};
  data.reminderMsgMap        ??= {};
  data.lastReminderMsgIds    ??= [];
  data.vcExcludeUsers        ??= [];
  data.activeVcSessions      ??= {};
  data.pendingDeleteSessions ??= {};
  data.saylaterJobs          ??= {};
  data.repeatJobs            ??= {};
  data.attendance            ??= {};
  data.reminderNotices       ??= {};
  data.channelSnapshot       ??= { savedAt: null, channels: {} };
  // メンバー表が無ければ初期値を入れる（空配列は「全員削除した」状態なのでそのまま）
  if (!Array.isArray(data.members)) data.members = structuredClone(DEFAULT_MEMBERS);
  if (!Array.isArray(data.reminderOffsets)) data.reminderOffsets = [60, 15];
  data.gjData ??= emptyGjData();
  return data;
}

const adapter = new JSONFile('settings.json');
export const db = new Low(adapter, structuredClone(defaultData));
await db.read();
db.data ||= structuredClone(defaultData);
normalizeData(db.data);
initGjData(db);

// 書き込みのたびに保存時刻を記録し、登録されたフック（自動バックアップ）を呼ぶ
const writeHooks = [];
export function onDbWrite(fn) { writeHooks.push(fn); }
const rawWrite = db.write.bind(db);
db.write = async () => {
  db.data.savedAt = new Date().toISOString();
  await rawWrite();
  for (const fn of writeHooks) { try { fn(); } catch (e) { console.error('書き込みフック失敗:', e.message); } }
};

// 起動時の初期化内容は保存するがバックアップは発火させない（復元前に空の状態で上書きしないため）
await rawWrite();
