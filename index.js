// index.js
// Version: 2.34.0

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import cron from 'node-cron';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { google } from 'googleapis';
import {
  Client, IntentsBitField, REST, Routes, Partials, Events,
  SlashCommandBuilder, AttachmentBuilder, ChannelType
} from 'discord.js';
import {
  joinVoiceChannel, getVoiceConnection
} from '@discordjs/voice';
import * as dotenv from 'dotenv';
import {
  GOOD_JOB_EMOJI_ID, GOOD_JOB_EMOJI_NAME, GJ_ANNOUNCE_CHANNEL,
  initGjData, getGjPoints, getDailySentCount, ensureMonthlyCounter,
  sendGoodJob, checkAchievements, sendMonthlyAwards,
} from './gj.js';
dotenv.config();

// ============================================================
// 環境変数
// ============================================================
const {
  DISCORD_TOKEN, GUILD_ID, ANNOUNCE_CHANNEL_ID,
  GOOGLE_SERVICE_ACCOUNT_KEY, GOOGLE_CALENDAR_ID,
  KLIPY_API_KEY,
} = process.env;
const PORT = process.env.PORT ?? 3000;
const DEFAULT_REMIND_CHANNEL_ID = '1357515614498848909';
const BOT_VERSION = '2.34.0';

if (!DISCORD_TOKEN || !GUILD_ID || !ANNOUNCE_CHANNEL_ID) {
  console.error('⚠️ 必要な環境変数が不足しています');
  process.exit(1);
}

// ============================================================
// メンバー設定
// ============================================================
const MEMBER_CONFIG = {
  // Discord User ID → { calendarId, label }
  '754606689000357978':  { calendarId: 'c7f96baa0ad2a16ff28b4f2a9f2aef456fe6fab3b3ba7f0f873982c07924034a@group.calendar.google.com', label: '【川畑】' },
  '1315207531081236511': { calendarId: 'c7f96baa0ad2a16ff28b4f2a9f2aef456fe6fab3b3ba7f0f873982c07924034a@group.calendar.google.com', label: '【川畑】' },
  '556120297330180109':  { calendarId: '26e8b54b64c26d4768d7248d47abc37729fda9c096755af5b75add915f4d0f3e@group.calendar.google.com', label: '【たか】' },
  '1139921498463813773': { calendarId: '26e8b54b64c26d4768d7248d47abc37729fda9c096755af5b75add915f4d0f3e@group.calendar.google.com', label: '【たか】' },
  '807553624359174165':  { calendarId: 'd8241c1d6c4ea36504a81b8bb5a818ec81ad570dc1a9b37b04a503c1c89e05fe@group.calendar.google.com', label: '【デクノ】' },
  '1267012064958742569': { calendarId: 'd8241c1d6c4ea36504a81b8bb5a818ec81ad570dc1a9b37b04a503c1c89e05fe@group.calendar.google.com', label: '【デクノ】' },
  '579931128270684161':  { calendarId: '2a8cb83586c5195204ada257461207033be93af563ad99ad6b77d72bf03cbf04@group.calendar.google.com', label: '【フェルム】' },
  '1327231705890820126': { calendarId: '2a8cb83586c5195204ada257461207033be93af563ad99ad6b77d72bf03cbf04@group.calendar.google.com', label: '【フェルム】' },
  '1078682735817785464': { calendarId: '3be73a6f8c0c045bed4e1c98633d78aa855763783164c0e509b2aaac948806fa@group.calendar.google.com', label: '【マド】' },
  '909785357250355301':  { calendarId: '56f593f99e9ad9d62d2716775400942a38aefb495b6528576a6f7c6274a4671f@group.calendar.google.com', label: '【小泉】' },
  '835380715867865098':  { calendarId: '89d88175048457539a85c48a2deac8d154d83216738894dc0e028f76ee132b95@group.calendar.google.com', label: '【りんけ】' },
  '559654864502915073':  { calendarId: '89d88175048457539a85c48a2deac8d154d83216738894dc0e028f76ee132b95@group.calendar.google.com', label: '【りんけ】' },
  '754637527654334514':  { calendarId: 'c6ae62fcb9a3abe8ab69551a848b965e56815a85e4c1eaf653c74cee80a4e738@group.calendar.google.com', label: '【アズ】' },
};

const MEMBER_CALENDARS = {
  'しいたけ': 'c7f96baa0ad2a16ff28b4f2a9f2aef456fe6fab3b3ba7f0f873982c07924034a@group.calendar.google.com',
  'たか':     '26e8b54b64c26d4768d7248d47abc37729fda9c096755af5b75add915f4d0f3e@group.calendar.google.com',
  'りんけ':   '89d88175048457539a85c48a2deac8d154d83216738894dc0e028f76ee132b95@group.calendar.google.com',
  'アズ':     'c6ae62fcb9a3abe8ab69551a848b965e56815a85e4c1eaf653c74cee80a4e738@group.calendar.google.com',
  'デクノ':   'd8241c1d6c4ea36504a81b8bb5a818ec81ad570dc1a9b37b04a503c1c89e05fe@group.calendar.google.com',
  'フェルム': '2a8cb83586c5195204ada257461207033be93af563ad99ad6b77d72bf03cbf04@group.calendar.google.com',
  'マドリガル':'3be73a6f8c0c045bed4e1c98633d78aa855763783164c0e509b2aaac948806fa@group.calendar.google.com',
  'リヨナロ': '56f593f99e9ad9d62d2716775400942a38aefb495b6528576a6f7c6274a4671f@group.calendar.google.com',
};

// ============================================================
// Google Calendar 初期化
// ============================================================
let calendarEnabled = false;
let calendar = null;

if (GOOGLE_SERVICE_ACCOUNT_KEY && GOOGLE_CALENDAR_ID) {
  try {
    const key = JSON.parse(GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.GoogleAuth({
      credentials: key,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    calendar = google.calendar({ version: 'v3', auth });
    calendarEnabled = true;
    console.log('✅ Google Calendar 連携が有効になりました');
  } catch (e) {
    console.error('⚠️ Google Calendar 初期化失敗:', e.message);
  }
}

// ============================================================
// 日時ヘルパー（サーバーのタイムゾーンに依存しないようJSTを明示的に扱う）
// ============================================================
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// JSTの年月日時分 → Date
function jstDate(year, month, day, hour = 0, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0) - JST_OFFSET_MS);
}

// 現在のJST年月日
function nowJstParts() {
  const j = new Date(Date.now() + JST_OFFSET_MS);
  return { year: j.getUTCFullYear(), month: j.getUTCMonth() + 1, day: j.getUTCDate() };
}

// 存在する日付か（2/31 などを弾く）
function isValidDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

// 月日だけ指定された日付の年を決める（今日より前なら来年扱い）
function resolveYear(month, day) {
  const n = nowJstParts();
  const today = Date.UTC(n.year, n.month - 1, n.day);
  return Date.UTC(n.year, month - 1, day) < today ? n.year + 1 : n.year;
}

// "HH:MM" → [h, m]（不正なら null）
function parseHHMM(str) {
  const m = /^(\d{1,2})[:：](\d{2})$/.exec((str ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return [h, min];
}

// 指定日時に1回だけ発火するcron式（JST）
function cronExprAt(date) {
  const jst = new Date(date.getTime() + JST_OFFSET_MS);
  return `${jst.getUTCMinutes()} ${jst.getUTCHours()} ${jst.getUTCDate()} ${jst.getUTCMonth() + 1} *`;
}

// 2000文字を超えるメッセージを分割して返信
async function replyLong(interaction, text) {
  const chunks = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf.length + line.length + 1 > 1900) { chunks.push(buf); buf = ''; }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf) chunks.push(buf);
  await interaction.editReply(chunks[0] || '（なし）');
  for (const c of chunks.slice(1)) await interaction.followUp(c);
}

// ============================================================
// Hono サーバー
// ============================================================
const app = new Hono();
app.get('/', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));
serve({ fetch: app.fetch, port: PORT });
console.log(`🌐 Web server running on port ${PORT}`);

const HEALTH_CHECK_URL = process.env.HEALTH_CHECK_URL || `http://localhost:${PORT}`;
cron.schedule('*/10 * * * *', async () => {
  const now = new Date().toLocaleString('ja-JP');
  try {
    const res = await fetch(HEALTH_CHECK_URL);
    if (res.ok) console.log(`✅ [${now}] ヘルスチェック成功: ${res.status}`);
  } catch (e) { console.error(`❌ ヘルスチェックエラー:`, e.message); }
}, { timezone: 'Asia/Tokyo' });

// ============================================================
// DB 初期化
// ============================================================
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
  gjData: { points: {}, history: [], achievements: {}, dailySent: {}, gjChain: null, monthlyCounters: {} },
  channelSnapshot: { savedAt: null, channels: {} },
};

const adapter = new JSONFile('settings.json');
const db = new Low(adapter, defaultData);
await db.read();
db.data ||= defaultData;
db.data.eventMap             ??= {};
db.data.eventRoles           ??= {};
db.data.reminderMsgMap       ??= {};
db.data.lastReminderMsgIds   ??= [];
db.data.vcExcludeUsers       ??= [];
db.data.activeVcSessions     ??= {};
db.data.pendingDeleteSessions ??= {};
db.data.saylaterJobs         ??= {};
initGjData(db);
db.data.channelSnapshot ??= { savedAt: null, channels: {} };
db.data.gjData               ??= { points: {}, history: [], achievements: {}, dailySent: {}, gjChain: null, monthlyCounters: {} };
db.data.gjData.points        ??= {};
db.data.gjData.history       ??= [];
db.data.gjData.achievements  ??= {};
db.data.gjData.dailySent     ??= {};
db.data.gjData.monthlyCounters ??= {};
if (!Array.isArray(db.data.reminderOffsets)) db.data.reminderOffsets = [60, 15];
await db.write();

// ============================================================
// Google Calendar ヘルパー
// ============================================================
function toCalendarEvent(event) {
  const startTime = new Date(event.scheduledStartTimestamp);
  const endTime = event.scheduledEndTimestamp
    ? new Date(event.scheduledEndTimestamp)
    : new Date(startTime.getTime() + 60 * 60 * 1000);
  return {
    summary: event.name,
    description: [
      event.description || '',
      '',
      `🔗 Discordイベント: https://discord.com/events/${GUILD_ID}/${event.id}`,
    ].join('\n').trim(),
    start: { dateTime: startTime.toISOString(), timeZone: 'Asia/Tokyo' },
    end:   { dateTime: endTime.toISOString(),   timeZone: 'Asia/Tokyo' },
    ...(event.entityMetadata?.location && { location: event.entityMetadata.location }),
    extendedProperties: { private: { discordEventId: event.id } },
  };
}

async function findCalendarEventByDiscordId(discordEventId) {
  if (!calendarEnabled) return null;
  try {
    const res = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      privateExtendedProperty: `discordEventId=${discordEventId}`,
      singleEvents: true,
      maxResults: 1,
    });
    const items = res.data.items ?? [];
    return items.length > 0 ? items[0] : null;
  } catch (e) {
    console.error('❌ カレンダー検索失敗:', e.message);
    return null;
  }
}

let calendarSyncRunning = false;
async function syncAllEventsToCalendar() {
  if (!calendarEnabled) return;
  // 同期の多重実行で同じ予定が二重登録されるのを防ぐ
  if (calendarSyncRunning) return;
  calendarSyncRunning = true;
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const all = await guild.scheduledEvents.fetch();
    for (const e of all.values()) {
      let gcalId = db.data.eventMap[e.id];
      if (gcalId) {
        // DBにある → 更新（404なら再検索）
        await calendar.events.patch({
          calendarId: GOOGLE_CALENDAR_ID,
          eventId: gcalId,
          resource: toCalendarEvent(e),
        }).catch(async (err) => {
          if (err.code === 404 || err.code === 410) {
            delete db.data.eventMap[e.id];
            const existing = await findCalendarEventByDiscordId(e.id);
            if (existing) {
              db.data.eventMap[e.id] = existing.id;
              await calendar.events.patch({
                calendarId: GOOGLE_CALENDAR_ID,
                eventId: existing.id,
                resource: toCalendarEvent(e),
              }).catch(() => {});
            } else {
              const res = await calendar.events.insert({
                calendarId: GOOGLE_CALENDAR_ID,
                resource: toCalendarEvent(e),
              });
              db.data.eventMap[e.id] = res.data.id;
              console.log(`📅 再作成: "${e.name}"`);
            }
          }
        });
      } else {
        // DBにない → Calendarを検索して重複確認
        const existing = await findCalendarEventByDiscordId(e.id);
        if (existing) {
          db.data.eventMap[e.id] = existing.id;
          await calendar.events.patch({
            calendarId: GOOGLE_CALENDAR_ID,
            eventId: existing.id,
            resource: toCalendarEvent(e),
          }).catch(() => {});
          console.log(`🔁 既存イベント復元: "${e.name}"`);
        } else {
          const res = await calendar.events.insert({
            calendarId: GOOGLE_CALENDAR_ID,
            resource: toCalendarEvent(e),
          });
          db.data.eventMap[e.id] = res.data.id;
          console.log(`📅 新規追加: "${e.name}"`);
        }
      }
    }
    await db.write();
    console.log(`🔄 Googleカレンダー同期完了 (${new Date().toLocaleString('ja-JP')})`);
  } catch (e) {
    console.error('❌ Googleカレンダー同期失敗:', e.message);
  } finally {
    calendarSyncRunning = false;
  }
}

async function deleteCalendarEvent(discordEventId, name = '不明') {
  if (!calendarEnabled) return;
  let gcalId = db.data.eventMap[discordEventId];
  if (!gcalId) {
    const existing = await findCalendarEventByDiscordId(discordEventId);
    if (existing) gcalId = existing.id;
  }
  if (!gcalId) return;
  try {
    await calendar.events.delete({ calendarId: GOOGLE_CALENDAR_ID, eventId: gcalId });
    delete db.data.eventMap[discordEventId];
    await db.write();
    console.log(`🗑️ Calendarから削除: "${name}"`);
  } catch (e) {
    if (e.code === 410 || e.code === 404) { delete db.data.eventMap[discordEventId]; await db.write(); }
    else console.error(`❌ Calendar削除失敗:`, e.message);
  }
}

async function writeParticipantsToCalendar(eventId, eventName) {
  if (!calendarEnabled) return;
  let gcalId = db.data.eventMap[eventId];
  if (!gcalId) {
    const existing = await findCalendarEventByDiscordId(eventId);
    if (existing) { gcalId = existing.id; db.data.eventMap[eventId] = gcalId; await db.write(); }
  }
  if (!gcalId) return;
  const session = db.data.activeVcSessions[eventId];
  if (!session) return;
  const excludeIds = db.data.vcExcludeUsers ?? [];
  const filteredIds = (session.participants ?? []).filter(id => !excludeIds.includes(id));
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const names = [];
    for (const uid of filteredIds) {
      const m = await guild.members.fetch(uid).catch(() => null);
      if (m) names.push(m.displayName);
    }
    const existing = await calendar.events.get({ calendarId: GOOGLE_CALENDAR_ID, eventId: gcalId });
    const oldDesc = existing.data.description || '';
    const newDesc = oldDesc + `\n\n🎙️ 参加者 (${names.length}名):\n` +
      (names.length > 0 ? names.map(n => `・${n}`).join('\n') : '（なし）');
    await calendar.events.patch({ calendarId: GOOGLE_CALENDAR_ID, eventId: gcalId, resource: { description: newDesc } });
    console.log(`📝 参加者書き込み: "${eventName}" (${names.length}名)`);
  } catch (e) { console.error(`❌ 参加者書き込み失敗:`, e.message); }
}

// ============================================================
// メンバーカレンダー横断検索
// ============================================================
async function queryMemberCalendars(target, targetHour) {
  if (!calendarEnabled) return [];
  const windowStart = jstDate(target.year, target.month, target.day, targetHour, 0);
  const windowEnd   = new Date(windowStart.getTime() + 60 * 60 * 1000);
  const results = [];
  for (const [name, calId] of Object.entries(MEMBER_CALENDARS)) {
    try {
      const res = await calendar.events.list({
        calendarId: calId,
        timeMin: windowStart.toISOString(),
        timeMax: windowEnd.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });
      for (const ev of (res.data.items ?? [])) {
        const isAllDay = !ev.start.dateTime;
        results.push({
          member: name,
          title: ev.summary,
          start: isAllDay ? ev.start.date : ev.start.dateTime,
          allDay: isAllDay,
        });
      }
    } catch (e) { console.error(`❌ ${name}カレンダー取得失敗:`, e.message); }
  }
  return results;
}

function formatCalendarResults(results, dateLabel) {
  if (results.length === 0) return `${dateLabel}\nこの時間の予定はありません`;
  const lines = results.map(r => {
    if (r.allDay || (r.start && !r.start.includes('T'))) return `・【${r.member}】${r.title}\n　[終日]`;
    const time = new Date(r.start).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });
    return `・【${r.member}】${r.title}\n　${time}〜`;
  });
  return `${dateLabel}\nこの時間の予定は以下${results.length}件です\n${lines.join('\n')}`;
}

function getWeekday(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.toLocaleDateString('ja-JP', { weekday: 'short', timeZone: 'Asia/Tokyo' });
}

// ============================================================
// VCセッション管理
// ============================================================
async function startVcSession(event) {
  if (!event.channelId) return;
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(event.channelId);
    if (!channel?.isVoiceBased()) return;
    // 参加者記録はVC接続の成否に関係なく先に開始する（記録はvoiceStateUpdateで行うため接続は必須ではない）
    const initialMembers = [...channel.members.keys()].filter(id => id !== client.user.id);
    db.data.activeVcSessions[event.id] = { channelId: event.channelId, participants: initialMembers };
    await db.write();
    console.log(`🎙️ VCセッション開始: "${event.name}" (初期: ${initialMembers.length}名)`);
    try {
      joinVoiceChannel({
        channelId: channel.id,
        guildId: GUILD_ID,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: true,
      });
    } catch (e) { console.error(`⚠️ VC接続失敗（参加者記録は継続）:`, e.message); }
  } catch (e) { console.error(`❌ VCセッション開始失敗:`, e.message); }
}

async function endVcSession(eventId, eventName) {
  try {
    const connection = getVoiceConnection(GUILD_ID);

    // 会議参加者にBotからGJを送信
    const session = db.data.activeVcSessions[eventId];
    if (session && session.participants?.length > 0) {
      const guild = await client.guilds.fetch(GUILD_ID);
      // 参加予定者ロールが設定されていればロール持ちのみ、なければ全員
      const roleId = db.data.eventRoles[eventId];
      let targets = session.participants;
      if (roleId) {
        const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
        if (role) targets = session.participants.filter(id => role.members.has(id));
      }
      if (targets.length > 0) {
        try {
          const ch = await guild.channels.fetch(ANNOUNCE_CHANNEL_ID);
          const mentions = targets.map(id => `<@${id}>`).join('');
          await ch.send({ content: `${mentions}
🔥 お前等、ナイス会議参加だったぜ！！俺からお前等全員にGJを送ってやる！！`, allowedMentions: { users: targets } });
          for (const uid of targets) {
            const member = await guild.members.fetch(uid).catch(() => null);
            if (!member) continue;
            // BotからのGJ（GJPのみ付与、GSPなし）
            const toPoints = getGjPoints(db, uid);
            toPoints.gjp++;
            ensureMonthlyCounter(db, uid).monthlyGjp++;
            db.data.gjData.history.push({
              from: client.user.id, to: uid, reason: 'ナイス会議参加!!!',
              anonymous: false, channelId: ANNOUNCE_CHANNEL_ID, timestamp: new Date().toISOString()
            });
            await checkAchievements(db, client, GUILD_ID, uid, 'received', ch);
          }
          await db.write();
        } catch (e) { console.error('会議GJ送信失敗:', e.message); }
      }
    }

    if (connection) connection.destroy();
    await writeParticipantsToCalendar(eventId, eventName);
    delete db.data.activeVcSessions[eventId];
    await db.write();
    console.log(`🎙️ VCセッション終了: "${eventName}"`);
  } catch (e) { console.error(`❌ VCセッション終了失敗:`, e.message); }
}

// ============================================================
// ロール管理
// ============================================================
async function getOrCreateEventRole(guild, event) {
  const existingRoleId = db.data.eventRoles[event.id];
  if (existingRoleId) {
    const role = guild.roles.cache.get(existingRoleId) || await guild.roles.fetch(existingRoleId).catch(() => null);
    if (role) return role;
  }
  await guild.roles.fetch();
  const existing = guild.roles.cache.find(r => r.name === `参加予定_${event.name}`);
  if (existing) { db.data.eventRoles[event.id] = existing.id; await db.write(); return existing; }
  const role = await guild.roles.create({
    name: `参加予定_${event.name}`,
    color: 0x57F287,
    reason: `イベント「${event.name}」用`,
  });
  db.data.eventRoles[event.id] = role.id;
  await db.write();
  console.log(`🎭 ロール作成: "${role.name}"`);
  return role;
}

async function deleteEventRole(guild, eventId, eventName = '不明') {
  const roleId = db.data.eventRoles[eventId];
  if (!roleId) return;
  try {
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (role) await role.delete();
    delete db.data.eventRoles[eventId];
    await db.write();
  } catch (e) { delete db.data.eventRoles[eventId]; await db.write(); }
}

async function stripAllEventRoles(guild) {
  await guild.roles.fetch();
  const targets = guild.roles.cache.filter(r => r.name.startsWith('参加予定_'));
  for (const role of targets.values()) {
    try { await role.delete('前日ロール削除'); console.log(`🗑️ ロール削除: ${role.name}`); }
    catch (e) { console.error(`❌ ロール削除失敗:`, e.message); }
  }
  db.data.eventRoles = {};
  await db.write();
  console.log('🧹 前日ロールを全削除しました');
}

// ============================================================
// cron 管理
// ============================================================
// desc → { task, expr, fn }
const jobMap = new Map();

function stopJob(desc) {
  const entry = jobMap.get(desc);
  if (!entry) return;
  entry.task.stop();
  entry.task.destroy?.();
  jobMap.delete(desc);
}

function registerCron(expr, jobFn, desc) {
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

function clearAllJobs() { for (const desc of [...jobMap.keys()]) stopJob(desc); }

// ============================================================
// イベント取得
// ============================================================
async function fetchTodaysEvents(guild) {
  const all = await guild.scheduledEvents.fetch();
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  return all.filter(e => {
    const d = new Date(new Date(e.scheduledStartTimestamp).toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` === todayStr;
  });
}

async function fetchWeekEvents(guild) {
  const now = new Date();
  const weekLater = new Date(now); weekLater.setDate(now.getDate() + 7);
  const all = await guild.scheduledEvents.fetch();
  return all.filter(e => { const s = new Date(e.scheduledStartTimestamp); return s >= now && s <= weekLater; });
}

// VC/ステージのイベントはチャンネルリンク、外部イベントは場所を表示
function eventPlace(e) {
  if (e.channelId) return `<https://discord.com/channels/${GUILD_ID}/${e.channelId}>`;
  return e.entityMetadata?.location || '（未設定）';
}

// ============================================================
// 朝リマインド
// ============================================================
async function sendMorningSummary(withEveryone = true) {
  const guild   = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(ANNOUNCE_CHANNEL_ID);
  const events  = await fetchTodaysEvents(guild);
  await stripAllEventRoles(guild);
  const mention = withEveryone ? '@everyone\n' : '';
  if (events.size === 0) {
    await channel.send({ content: `${mention}📭 本日のイベントはありません`, allowedMentions: { parse: withEveryone ? ['everyone'] : [] } });
    return;
  }
  const newMsgIds = [], newMsgMap = {};
  await channel.send({ content: `${mention}📅 本日のイベント一覧 (${events.size}件)`, allowedMentions: { parse: withEveryone ? ['everyone'] : [] } });
  for (const e of events.values()) {
    const role     = await getOrCreateEventRole(guild, e);
    const time     = new Date(e.scheduledStartTimestamp).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const host     = e.creator?.username || '不明';
    const chanUrl  = eventPlace(e);
    const eventUrl = `https://discord.com/events/${GUILD_ID}/${e.id}`;
    const msg = `## ◆${e.name}\n${time} / ${host}\n📍 チャンネル: ${chanUrl}\n🔗 イベント:   <${eventUrl}>\n✅ 出席／❌ 欠席 で参加表明お願いします！`;
    const sent = await channel.send({ content: msg, allowedMentions: { roles: [role.id] } });
    await sent.react('✅');
    await sent.react('❌');
    newMsgIds.push(sent.id);
    newMsgMap[sent.id] = e.id;
  }
  db.data.lastReminderMsgIds = newMsgIds;
  db.data.reminderMsgMap = newMsgMap;
  await db.write();
}

// ============================================================
// イベントcron登録（重複防止付き）
// ============================================================
// イベント用cronのキーは `event:<イベントID>:<種類>`。
// 毎回「今あるべきcron」の集合を作り、それ以外の event: cron を止める。
// これでキャンセル・削除・時刻変更・同名イベントにも正しく追従する。
const EVENT_JOB_PREFIX = 'event:';
const PAST_GRACE_MS = 60 * 1000;

async function scheduleEventReminders() {
  const guild  = await client.guilds.fetch(GUILD_ID);
  const events = await fetchTodaysEvents(guild);
  const wanted = new Set();
  const now = Date.now();

  // 過去の時刻は登録しない（日付指定のcronは翌年に発火してしまうため）
  const registerEventCron = (at, fn, desc) => {
    if (at.getTime() < now - PAST_GRACE_MS) return;
    wanted.add(desc);
    registerCron(cronExprAt(at), fn, desc);
  };

  for (const offset of (db.data.reminderOffsets ?? [60, 15])) {
    for (const e of events.values()) {
      if (e.status !== 1) continue; // 予定(SCHEDULED)のみ
      const target = new Date(e.scheduledStartTimestamp - offset * 60000);
      const chanUrl  = eventPlace(e);
      const eventUrl = `https://discord.com/events/${GUILD_ID}/${e.id}`;
      registerEventCron(target, async () => {
        const g    = await client.guilds.fetch(GUILD_ID);
        // イベントがまだ存在するか確認
        const currentEvents = await g.scheduledEvents.fetch();
        if (!currentEvents.has(e.id)) return;
        const ch   = await g.channels.fetch(ANNOUNCE_CHANNEL_ID);
        const role = await getOrCreateEventRole(g, e);
        await ch.send({ content: `${role}\n⏰ **${offset}分前リマインド** 「${e.name}」\n📍 チャンネル: ${chanUrl}\n🔗 イベント:   <${eventUrl}>`, allowedMentions: { roles: [role.id] } });
      }, `${EVENT_JOB_PREFIX}${e.id}:reminder:${offset}`);
    }
  }

  for (const e of events.values()) {
    if (e.status !== 1 && e.status !== 2) continue; // 予定 or 開催中のみ
    const startTs  = e.scheduledStartTimestamp;
    const chanUrl  = eventPlace(e);
    const eventUrl = `https://discord.com/events/${GUILD_ID}/${e.id}`;

    // 開始アナウンス
    registerEventCron(new Date(startTs), async () => {
      const g = await client.guilds.fetch(GUILD_ID);
      const currentEvents = await g.scheduledEvents.fetch();
      if (!currentEvents.has(e.id)) return;
      const ch = await g.channels.fetch(ANNOUNCE_CHANNEL_ID);
      await ch.send({ content: `@everyone\n🚀 **「${e.name}」が始まりました！**\n📍 会場: ${chanUrl}\n🔗 イベント: <${eventUrl}>`, allowedMentions: { parse: ['everyone'] } });
    }, `${EVENT_JOB_PREFIX}${e.id}:start`);

    // 開始3分後：未参加チェック
    registerEventCron(new Date(startTs + 3 * 60000), async () => {
      const g = await client.guilds.fetch(GUILD_ID);
      const currentEvents = await g.scheduledEvents.fetch();
      if (!currentEvents.has(e.id)) return;
      const ch   = await g.channels.fetch(ANNOUNCE_CHANNEL_ID);
      const role = await getOrCreateEventRole(g, e);
      const vcCh = e.channelId ? await g.channels.fetch(e.channelId).catch(() => null) : null;
      if (!vcCh) return;
      // role.members はキャッシュ依存なのでメンバーを取得しておく
      await g.members.fetch().catch(() => {});
      const vcIds    = new Set(vcCh.members?.keys() ?? []);
      const absentees = role.members.filter(m => !vcIds.has(m.id));
      if (absentees.size === 0) return;
      await ch.send({ content: `⚠️ 以下の出席予定者が参加していません:\n${absentees.map(m => `<@${m.id}>`).join('\n')}`, allowedMentions: { users: [...absentees.keys()] } });
    }, `${EVENT_JOB_PREFIX}${e.id}:absence`);

    // 開始5分後：まだ開始していなければ通知
    registerEventCron(new Date(startTs + 5 * 60000), async () => {
      const g = await client.guilds.fetch(GUILD_ID);
      const currentEvents = await g.scheduledEvents.fetch();
      const currentEvent  = currentEvents.get(e.id);
      // 予定(SCHEDULED=1)のままなら未開始。開催中・完了・キャンセルなら何もしない
      if (!currentEvent || currentEvent.status !== 1) return;
      const ch = await g.channels.fetch(ANNOUNCE_CHANNEL_ID);
      await ch.send({ content: `⚠️ 「${e.name}」はまだ開始されていません` });
    }, `${EVENT_JOB_PREFIX}${e.id}:not-started`);
  }

  // 不要になったイベントcron（キャンセル・削除・時刻変更前・過去分・削除したオフセット）を停止
  for (const desc of [...jobMap.keys()]) {
    if (desc.startsWith(EVENT_JOB_PREFIX) && !wanted.has(desc)) {
      stopJob(desc);
      console.log(`🗑️ cronを削除: ${desc}`);
    }
  }
}

function scheduleDailyReminders() {
  const [h, m] = (db.data.morningTime || '07:00').split(':');
  registerCron(`0 ${m} ${h} * * *`, () => sendMorningSummary(true), 'morning-summary');
  registerCron('0 0 * * *', scheduleEventReminders, 'daily-reschedule');
}

function bootstrapSchedules() {
  clearAllJobs();
  scheduleDailyReminders();
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
  // 月間表彰（毎月末日23:59）
  registerCron('59 23 L * *', async () => {
    await sendMonthlyAwards(db, client, GUILD_ID);
  }, 'monthly-awards');
}

async function sendSaylater(job) {
  const ch = await client.channels.fetch(job.channelId);
  await ch.send(`<@${job.mentionId}>\n${job.message}`);
}

// 伝言予約1件をcronに登録（新規作成・復元の共通処理）
function scheduleSaylaterJob(id) {
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

function restoreSaylaterJobs() {
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
    console.log(`📬 伝言予約復元: ${new Date(job.fireAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} "${job.message.slice(0, 20)}"`);
  }
}

// ============================================================
// Klipy GIF ヘルパー
// ============================================================
async function klipyFetch(endpoint) {
  // /api/v1/{key}/ 形式と /api/v1/k/{key}/ 形式を両方試す
  const url = `https://api.klipy.com/api/v1/${KLIPY_API_KEY}${endpoint}`;
  console.log(`🎬 Klipy request: ${url.replace(KLIPY_API_KEY, '[KEY]')}`);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Klipy API error: ${res.status} (${body.slice(0, 200)})`);
  }
  return res.json();
}

function extractGifUrl(item) {
  if (!item) return null;
  // Klipy形式: item.file.hd.gif.url
  if (item.file) {
    return item.file.hd?.gif?.url ?? item.file.hd?.webp?.url
        ?? item.file.sd?.gif?.url ?? item.file.sd?.webp?.url ?? null;
  }
  if (typeof item.url === 'string' && item.url.includes('http')) return item.url;
  if (item.media && !Array.isArray(item.media)) {
    return item.media.gif?.url ?? item.media.tinygif?.url ?? item.media.mediumgif?.url ?? null;
  }
  if (Array.isArray(item.media) && item.media[0]) {
    const m = item.media[0];
    return m.gif?.url ?? m.tinygif?.url ?? m.mediumgif?.url ?? null;
  }
  return item.gif_url ?? item.images?.original?.url ?? null;
}

// Klipy APIレスポンスからアイテム配列を取得
function extractKlipyItems(data) {
  // Klipy形式: { result: true, data: { data: [...] } }
  const inner = data?.data;
  if (Array.isArray(inner?.data)) return inner.data;
  if (Array.isArray(inner)) return inner;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

async function getRandomGif() {
  const randomWords = ['funny', 'happy', 'cool', 'wow', 'yes', 'ok', 'love', 'party', 'amazing', 'cute'];
  const word  = randomWords[Math.floor(Math.random() * randomWords.length)];
  const data  = await klipyFetch(`/gifs/search?q=${encodeURIComponent(word)}&limit=50`);
  const items = extractKlipyItems(data);
  if (items.length === 0) throw new Error('GIFが取得できませんでした');
  const item  = items[Math.floor(Math.random() * items.length)];
  const url   = extractGifUrl(item);
  if (!url) throw new Error('GIFのURLが取得できませんでした');
  return url;
}

async function getKlipyCategories() {
  try {
    const data = await klipyFetch('/gifs/categories');
    console.log('🎬 Klipyカテゴリレスポンス keys:', Object.keys(data ?? {}).join(', '));
    // レスポンス形式を柔軟に処理
    const result = data?.data ?? data?.tags ?? data?.results ?? data?.categories ?? [];
    return Array.isArray(result) ? result : [];
  } catch (e) {
    console.error('カテゴリ取得失敗:', e.message);
    return [];
  }
}

async function getRandomGifByCategory(categoryName) {
  const data  = await klipyFetch(`/gifs/search?q=${encodeURIComponent(categoryName)}&limit=50`);
  const items = extractKlipyItems(data);
  if (items.length === 0) throw new Error('GIFが取得できませんでした');
  const item  = items[Math.floor(Math.random() * items.length)];
  const url   = extractGifUrl(item);
  if (!url) throw new Error('GIFのURLが取得できませんでした');
  return url;
}

// ============================================================
// ランダムカタカナ
// ============================================================
function generateRandomKatakana(length) {
  const chars = [
    'ア','イ','ウ','エ','オ','カ','キ','ク','ケ','コ',
    'サ','シ','ス','セ','ソ','タ','チ','ツ','テ','ト',
    'ナ','ニ','ヌ','ネ','ノ','ハ','ヒ','フ','ヘ','ホ',
    'マ','ミ','ム','メ','モ','ヤ','ユ','ヨ',
    'ラ','リ','ル','レ','ロ','ワ','ヲ','ン','ッ','ー',
    'ガ','ギ','グ','ゲ','ゴ','ザ','ジ','ズ','ゼ','ゾ',
    'ダ','ヂ','ヅ','デ','ド','バ','ビ','ブ','ベ','ボ',
    'パ','ピ','プ','ペ','ポ',
    'キャ','キュ','キョ','シャ','シュ','ショ','シェ',
    'チャ','チュ','チョ','チェ','ニャ','ニュ','ニョ',
    'ヒャ','ヒュ','ヒョ','ミャ','ミュ','ミョ',
    'リャ','リュ','リョ','ギャ','ギュ','ギョ',
    'ジャ','ジュ','ジョ','ジェ','ビャ','ビュ','ビョ',
    'ピャ','ピュ','ピョ','ファ','フィ','フェ','フォ',
    'ヴァ','ヴィ','ヴ','ヴェ','ヴォ','ウィ','ウェ','ウォ',
  ];
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ============================================================
// Discord Client
// ============================================================
const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.GuildMessageReactions,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.GuildScheduledEvents,
    IntentsBitField.Flags.GuildVoiceStates,
    IntentsBitField.Flags.MessageContent,
  ],
  // Bot起動前のメッセージ（朝リマインド等）へのリアクションも受け取るために必要
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User, Partials.GuildMember],
});

// ============================================================
// リアクション処理
// ============================================================
async function handleReaction(reaction, user, add) {
  // partial（キャッシュにない古いメッセージ）の場合は取得し直す
  if (reaction.partial) await reaction.fetch().catch(() => {});
  if (reaction.message.partial) await reaction.message.fetch().catch(() => {});
  if (user.partial) user = await user.fetch().catch(() => user);
  if (user.bot) return;

  // GOOD_JOBリアクション処理
  if (reaction.emoji.id === GOOD_JOB_EMOJI_ID || reaction.emoji.name === GOOD_JOB_EMOJI_NAME) {
    if (add) {
      const fromId   = user.id;
      const toId     = reaction.message.author?.id;
      if (toId && fromId !== toId && !reaction.message.author?.bot) {
        try {
          const guild   = await client.guilds.fetch(GUILD_ID);
          const fromMember = await guild.members.fetch(fromId).catch(() => null);
          const toMember   = await guild.members.fetch(toId).catch(() => null);
          if (fromMember && toMember) {
            // partialの場合はfetchして確実にチャンネルを取得
            const ch = reaction.message.channel.partial
              ? await reaction.message.channel.fetch().catch(() => reaction.message.channel)
              : reaction.message.channel;
            console.log(`👍 GJリアクション: ${fromMember.displayName} → ${toMember.displayName}`);
            const result = await sendGoodJob(db, client, GUILD_ID, {
              fromId, fromName: fromMember.displayName,
              toId,   toName:   toMember.displayName,
              reason: null, anonymous: false, channel: ch
            });
            if (!result.success) {
              // 通常メッセージには「自分だけに表示」が使えないので、少し後に消す
              const notice = await ch.send({ content: `<@${fromId}> ${result.reason}`, allowedMentions: { users: [fromId] } }).catch(() => null);
              if (notice) setTimeout(() => notice.delete().catch(() => {}), 10000);
            }
          }
        } catch (e) { console.error('GJリアクション処理失敗:', e.message); }
      }
    }
    return;
  }

  // 朝リマインドの出欠リアクション
  if (reaction.emoji.name === '✅') {
    const msgId = reaction.message.id;
    if (db.data.lastReminderMsgIds?.includes(msgId)) {
      const eventId = db.data.reminderMsgMap?.[msgId];
      if (!eventId) return;
      const guild  = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) return;
      const roleId = db.data.eventRoles[eventId];
      if (!roleId) return;
      const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
      if (!role) return;
      if (add) await member.roles.add(role).catch(() => {});
      else     await member.roles.remove(role).catch(() => {});
      console.log(`${add ? '✅' : '❌'} ${user.username} → ${role.name}`);
      return;
    }
  }

  // 予定削除のリアクション処理
  const session = db.data.pendingDeleteSessions?.[user.id];
  if (!session || reaction.message.id !== session.msgId) return;
  if (user.id !== session.requesterId) return; // 本人以外は無視

  if (!add) return; // 削除選択はリアクションを付けたときだけ反応する
  const emojiName = reaction.emoji.name;

  // キャンセル
  if (emojiName === '❌') {
    delete db.data.pendingDeleteSessions[user.id];
    await db.write();
    await reaction.message.reply('🚫 削除をキャンセルしました');
    return;
  }

  // 数字リアクション
  const numberEmojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
  const idx = numberEmojis.indexOf(emojiName);
  if (idx === -1 || idx >= session.events.length) return;

  const targetEvent = session.events[idx];
  try {
    if (!calendarEnabled) throw new Error('Calendar未設定');
    await calendar.events.delete({ calendarId: session.calendarId, eventId: targetEvent.id });
    delete db.data.pendingDeleteSessions[user.id];
    await db.write();
    await reaction.message.reply(`✅ 「${targetEvent.summary}」を削除しました`);
    console.log(`🗑️ 予定削除: "${targetEvent.summary}" by ${user.username}`);
  } catch (e) {
    await reaction.message.reply(`❌ 削除に失敗しました: ${e.message}`);
  }
}

client.on(Events.MessageReactionAdd,    (r, u) => handleReaction(r, u, true).catch(e => console.error('リアクション処理エラー:', e.message)));
client.on(Events.MessageReactionRemove, (r, u) => handleReaction(r, u, false).catch(e => console.error('リアクション処理エラー:', e.message)));

// ============================================================
// VC入室監視
// ============================================================
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (newState.guild.id !== GUILD_ID) return;
  const userId = newState.id;
  if (userId === client.user.id) return;
  if (!newState.channelId || newState.channelId === oldState.channelId) return;
  for (const [eventId, session] of Object.entries(db.data.activeVcSessions)) {
    if (session.channelId !== newState.channelId) continue;
    if ((db.data.vcExcludeUsers ?? []).includes(userId)) continue;
    if (!session.participants.includes(userId)) {
      session.participants.push(userId);
      await db.write();
      console.log(`🎙️ VC参加記録: ${userId}`);
    }
  }
});

// ============================================================
// Discordイベント検知
// ============================================================
client.on(Events.GuildScheduledEventUpdate, async (oldEvent, newEvent) => {
  if (newEvent.guildId !== GUILD_ID) return;

  // ACTIVE（開始）
  if (newEvent.status === 2 && oldEvent?.status !== 2) {
    console.log(`▶ イベント開始: "${newEvent.name}"`);
    await startVcSession(newEvent);
    await scheduleEventReminders();
    return;
  }
  // 完了
  if (newEvent.status === 3 && oldEvent?.status !== 3) {
    console.log(`⏹ イベント完了: "${newEvent.name}"`);
    await endVcSession(newEvent.id, newEvent.name);
    const guild = await client.guilds.fetch(GUILD_ID);
    await deleteEventRole(guild, newEvent.id, newEvent.name);
    await scheduleEventReminders();
    return;
  }
  // キャンセル
  if (newEvent.status === 4) {
    const guild = await client.guilds.fetch(GUILD_ID);
    await deleteEventRole(guild, newEvent.id, newEvent.name);
    await deleteCalendarEvent(newEvent.id, newEvent.name);
    delete db.data.activeVcSessions[newEvent.id];
    await db.write();
    await scheduleEventReminders();
    return;
  }
  // 時刻・名前などの変更 → cronを即座に更新
  await scheduleEventReminders();
});

client.on(Events.GuildScheduledEventCreate, async event => {
  if (event.guildId !== GUILD_ID) return;
  await scheduleEventReminders();
});

client.on(Events.GuildScheduledEventDelete, async event => {
  if (event.guildId !== GUILD_ID) return;
  const guild = await client.guilds.fetch(GUILD_ID);
  await deleteEventRole(guild, event.id, event.name);
  await deleteCalendarEvent(event.id, event.name);
  delete db.data.activeVcSessions[event.id];
  await db.write();
  await scheduleEventReminders();
});

// ============================================================
// コマンド登録 & Bot起動
// ============================================================
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag} (v${BOT_VERSION})`);
  console.log(`   → morningTime = ${db.data.morningTime}`);
  console.log(`   → offsets     = ${db.data.reminderOffsets.join(',')}`);

  // コマンド登録に失敗してもリマインド等は動くように、先にスケジュールを起動する
  bootstrapSchedules();

  // GIFカテゴリを取得してコマンドのchoicesに使う
  let gifCategories = [];
  if (KLIPY_API_KEY) {
    try {
      gifCategories = await getKlipyCategories();
    } catch (e) {
      console.error('⚠️ Klipyカテゴリ取得失敗:', e.message);
    }
  }

  const safeCats = Array.isArray(gifCategories) ? gifCategories : [];
  console.log(`🎬 Klipyカテゴリ取得: ${safeCats.length}件`);
  // Discordのchoicesは name/value とも1〜100文字・value重複不可
  const seenValues = new Set();
  const gifCategoryChoices = safeCats
    .map(c => (typeof c === 'string' ? { name: c, value: c } : { name: c?.name ?? c?.slug, value: c?.slug ?? c?.name }))
    .map(c => ({ name: String(c.name ?? '').slice(0, 100), value: String(c.value ?? '').slice(0, 100) }))
    .filter(c => c.name && c.value && !seenValues.has(c.value) && seenValues.add(c.value))
    .slice(0, 25);

  // カテゴリが取れなかった場合はフォールバック
  const fallbackCategories = [
    { name: '喜び', value: 'happy' }, { name: '怒り', value: 'angry' },
    { name: '悲しみ', value: 'sad' }, { name: '驚き', value: 'surprised' },
    { name: '困惑', value: 'confused' }, { name: 'OK/了解', value: 'ok' },
    { name: 'ありがとう', value: 'thank you' }, { name: 'ごめん', value: 'sorry' },
    { name: '草/笑', value: 'laughing' }, { name: '最高', value: 'awesome' },
  ];
  const categoryChoices = gifCategoryChoices.length > 0 ? gifCategoryChoices : fallbackCategories;

  const commands = [
    new SlashCommandBuilder().setName('ping').setDescription('Bot疎通チェック'),
    new SlashCommandBuilder()
      .setName('set-morning-time').setDescription('朝リマインドの時刻を設定')
      .addStringOption(o => o.setName('time').setDescription('HH:MM形式').setRequired(true)),
    new SlashCommandBuilder()
      .setName('add-reminder-offset').setDescription('リマインド時刻を追加')
      .addIntegerOption(o => o.setName('minutes').setDescription('何分前').setRequired(true)),
    new SlashCommandBuilder()
      .setName('remove-reminder-offset').setDescription('リマインド時刻を削除')
      .addIntegerOption(o => o.setName('minutes').setDescription('何分前').setRequired(true)),
    new SlashCommandBuilder().setName('list-reminder-offsets').setDescription('リマインド時刻一覧'),
    new SlashCommandBuilder().setName('week-events').setDescription('直近1週間のイベント一覧'),
    new SlashCommandBuilder().setName('sync-calendar').setDescription('Googleカレンダーに一括同期'),
    new SlashCommandBuilder().setName('force-remind').setDescription('朝リマインドを今すぐ送信（@everyoneあり）'),
    new SlashCommandBuilder().setName('n-force-remind').setDescription('朝リマインドを今すぐ送信（@everyoneなし）'),
    new SlashCommandBuilder()
      .setName('connection-change').setDescription('チャンネルの接続設定を変更する')
      .addChannelOption(o => o.setName('channel').setDescription('対象チャンネル').setRequired(true))
      .addStringOption(o => o.setName('serial-number').setDescription('シリアルナンバー').setRequired(true)),
    new SlashCommandBuilder()
      .setName('random-katakana').setDescription('ランダムカタカナ文字列を生成')
      .addIntegerOption(o => o.setName('length').setDescription('文字数（1〜100）').setRequired(true).setMinValue(1).setMaxValue(100)),
    new SlashCommandBuilder().setName('gif-random').setDescription('ランダムなGIFを送信する'),
    new SlashCommandBuilder()
      .setName('gif-category').setDescription('カテゴリからランダムにGIFを送信する')
      .addStringOption(o => o.setName('category').setDescription('カテゴリ').setRequired(true).addChoices(...categoryChoices)),
    new SlashCommandBuilder()
      .setName('exclude-user-add').setDescription('参加者記録の除外ユーザーを追加')
      .addUserOption(o => o.setName('user').setDescription('ユーザー').setRequired(true)),
    new SlashCommandBuilder()
      .setName('exclude-user-remove').setDescription('除外ユーザーを解除')
      .addUserOption(o => o.setName('user').setDescription('ユーザー').setRequired(true)),
    new SlashCommandBuilder().setName('exclude-user-list').setDescription('除外ユーザー一覧'),
    new SlashCommandBuilder().setName('exclude-user-export').setDescription('除外リストをJSONでエクスポート'),
    new SlashCommandBuilder()
      .setName('exclude-user-import').setDescription('除外リストをJSONからインポート')
      .addAttachmentOption(o => o.setName('file').setDescription('JSONファイル').setRequired(true)),
    new SlashCommandBuilder()
      .setName('tm').setDescription('指定日時のメンバーカレンダーを確認')
      .addIntegerOption(o => o.setName('month').setDescription('月').setRequired(true).setMinValue(1).setMaxValue(12))
      .addIntegerOption(o => o.setName('day').setDescription('日').setRequired(true).setMinValue(1).setMaxValue(31))
      .addStringOption(o => o.setName('time').setDescription('時刻（例: 20:00）').setRequired(true)),
    new SlashCommandBuilder()
      .setName('tm-week').setDescription('本日から1週間の指定時刻のカレンダーを確認')
      .addStringOption(o => o.setName('time').setDescription('時刻（例: 20:00）').setRequired(true)),
    new SlashCommandBuilder()
      .setName('cal-add').setDescription('Googleカレンダーに予定を追加（単一予定）')
      .addIntegerOption(o => o.setName('month').setDescription('月').setRequired(true).setMinValue(1).setMaxValue(12))
      .addIntegerOption(o => o.setName('day').setDescription('日').setRequired(true).setMinValue(1).setMaxValue(31))
      .addStringOption(o => o.setName('start-time').setDescription('開始時刻（例: 19:00）').setRequired(true))
      .addStringOption(o => o.setName('end-time').setDescription('終了時刻（例: 21:00）').setRequired(true))
      .addStringOption(o => o.setName('title').setDescription('予定名（空欄で「予定」）').setRequired(false)),
    new SlashCommandBuilder()
      .setName('cal-add-allday').setDescription('Googleカレンダーに終日予定を追加')
      .addIntegerOption(o => o.setName('start-month').setDescription('開始月').setRequired(true).setMinValue(1).setMaxValue(12))
      .addIntegerOption(o => o.setName('start-day').setDescription('開始日').setRequired(true).setMinValue(1).setMaxValue(31))
      .addIntegerOption(o => o.setName('end-month').setDescription('終了月').setRequired(true).setMinValue(1).setMaxValue(12))
      .addIntegerOption(o => o.setName('end-day').setDescription('終了日').setRequired(true).setMinValue(1).setMaxValue(31))
      .addStringOption(o => o.setName('title').setDescription('予定名（空欄で「予定」）').setRequired(false)),
    new SlashCommandBuilder()
      .setName('cal-delete').setDescription('Googleカレンダーの予定を削除')
      .addIntegerOption(o => o.setName('weeks').setDescription('何週間先まで表示するか（1〜）').setRequired(true).setMinValue(1).setMaxValue(52)),
    new SlashCommandBuilder().setName('debug-events').setDescription('Botが把握しているイベント情報を表示する'),
    new SlashCommandBuilder()
      .setName('dice').setDescription('サイコロを振る')
      .addIntegerOption(o => o.setName('faces').setDescription('面の数（2〜99999999999）').setRequired(true).setMinValue(2).setMaxValue(99999999999))
      .addIntegerOption(o => o.setName('count').setDescription('個数（1〜100）').setRequired(true).setMinValue(1).setMaxValue(100)),
    new SlashCommandBuilder()
      .setName('anonymous').setDescription('匿名メッセージを送信する')
      .addChannelOption(o => o.setName('channel').setDescription('送信先チャンネル').setRequired(true))
      .addStringOption(o => o.setName('message').setDescription('送信するメッセージ').setRequired(true)),
    new SlashCommandBuilder().setName('version').setDescription('Botのバージョンを表示する'),
    new SlashCommandBuilder().setName('state-export').setDescription('Botの全状態をJSONでエクスポート（管理者専用）'),
    new SlashCommandBuilder()
      .setName('state-import').setDescription('JSONファイルからBotの状態をインポート（管理者専用）')
      .addAttachmentOption(o => o.setName('file').setDescription('エクスポートしたJSONファイル').setRequired(true)),
    new SlashCommandBuilder()
      .setName('saylatter-rel').setDescription('伝言予約：〇分後・〇時間後・〇日後に送信する')
      .addIntegerOption(o => o.setName('value').setDescription('数値').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('unit').setDescription('単位').setRequired(true)
        .addChoices(
          { name: '分後', value: 'minutes' },
          { name: '時間後', value: 'hours' },
          { name: '日後', value: 'days' },
        ))
      .addStringOption(o => o.setName('message').setDescription('リマインド本文').setRequired(true))
      .addUserOption(o => o.setName('mention').setDescription('メンション相手（デフォルト: 自分）').setRequired(false))
      .addChannelOption(o => o.setName('channel').setDescription('送信先チャンネル（デフォルト: いろいろ）').setRequired(false)),
    new SlashCommandBuilder()
      .setName('saylatter-abs').setDescription('伝言予約：日付と時刻を指定して送信する')
      .addIntegerOption(o => o.setName('month').setDescription('月').setRequired(true).setMinValue(1).setMaxValue(12))
      .addIntegerOption(o => o.setName('day').setDescription('日').setRequired(true).setMinValue(1).setMaxValue(31))
      .addStringOption(o => o.setName('time').setDescription('時刻（例: 20:00）').setRequired(true))
      .addStringOption(o => o.setName('message').setDescription('リマインド本文').setRequired(true))
      .addUserOption(o => o.setName('mention').setDescription('メンション相手（デフォルト: 自分）').setRequired(false))
      .addChannelOption(o => o.setName('channel').setDescription('送信先チャンネル（デフォルト: いろいろ）').setRequired(false)),
    new SlashCommandBuilder()
      .setName('goodjob').setDescription('グッジョブを送信する')
      .addUserOption(o => o.setName('target').setDescription('対象ユーザー').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('一言コメント（任意）').setRequired(false))
      .addBooleanOption(o => o.setName('anonymous').setDescription('匿名にする（匿名はGSP付与なし）').setRequired(false)),
    new SlashCommandBuilder()
      .setName('goodjob-history').setDescription('グッジョブ履歴を確認する')
      .addUserOption(o => o.setName('target').setDescription('確認するユーザー（省略で自分）').setRequired(false)),
    new SlashCommandBuilder()
      .setName('goodjob-ranking').setDescription('グッジョブランキングを表示する'),
    new SlashCommandBuilder()
      .setName('goodjob-status').setDescription('自分のグッジョブステータスを確認する'),
    new SlashCommandBuilder()
      .setName('saylatter-list').setDescription('設定中の伝言予約一覧を表示する'),
    new SlashCommandBuilder()
      .setName('saylatter-cancel').setDescription('伝言予約をキャンセルする')
      .addIntegerOption(o => o.setName('number').setDescription('キャンセルする番号（/saylatter-listで確認）').setRequired(true).setMinValue(1)),
    new SlashCommandBuilder()
      .setName('activity-save')
      .setDescription('全チャンネルの現在の状態を記録する'),
    new SlashCommandBuilder()
      .setName('activity-check')
      .setDescription('前回の記録以降に更新のあったチャンネルを表示する'),
    new SlashCommandBuilder()
      .setName('purge')
      .setDescription('指定時間前までのメッセージを削除する（管理者専用）')
      .addIntegerOption(o => o.setName('value').setDescription('数値').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('unit').setDescription('単位').setRequired(true)
        .addChoices(
          { name: '分前', value: 'minutes' },
          { name: '時間前', value: 'hours' },
        ))
      .addUserOption(o => o.setName('exclude-user').setDescription('削除しないメンバー（任意）').setRequired(false))
      .addUserOption(o => o.setName('only-user').setDescription('このメンバーのメッセージだけ削除（任意）').setRequired(false))
      .addStringOption(o => o.setName('match-text').setDescription('一致するメッセージだけ削除（任意）').setRequired(false))
      .addStringOption(o => o.setName('match-type').setDescription('一致方法').setRequired(false)
        .addChoices(
          { name: '部分一致', value: 'partial' },
          { name: '完全一致', value: 'exact' },
        )),
  ].map(c => c.toJSON());

  try {
    await new REST({ version: '10' }).setToken(DISCORD_TOKEN)
      .put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (e) {
    console.error('❌ スラッシュコマンド登録失敗:', e);
  }
});

// ============================================================
// コマンドハンドラ
// ============================================================
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    await handleCommand(interaction);
  } catch (e) {
    // 10062 = Unknown interaction（3秒以内に応答できなかった）
    if (e?.code === 10062) {
      console.warn(`⚠️ インタラクション期限切れ: /${interaction.commandName}`);
      return;
    }
    console.error(`❌ コマンドエラー (/${interaction.commandName}):`, e);
    const content = `❌ エラーが発生しました: ${e?.message ?? e}`;
    try {
      if (interaction.deferred || interaction.replied) await interaction.followUp({ content, flags: 64 });
      else await interaction.reply({ content, flags: 64 });
    } catch {}
  }
});

async function handleCommand(interaction) {
  switch (interaction.commandName) {
    case 'ping': return interaction.reply('Pong!');

    case 'set-morning-time': {
      const parsed = parseHHMM(interaction.options.getString('time'));
      if (!parsed) return interaction.reply({ content: '❌ 時刻は HH:MM 形式（例: 07:00）で指定してください', flags: 64 });
      const time = `${String(parsed[0]).padStart(2, '0')}:${String(parsed[1]).padStart(2, '0')}`;
      db.data.morningTime = time;
      await db.write();
      bootstrapSchedules();
      return interaction.reply(`✅ 朝リマインドを **${time}** に設定しました`);
    }

    case 'add-reminder-offset': {
      const min = interaction.options.getInteger('minutes');
      db.data.reminderOffsets ??= [];
      if (!db.data.reminderOffsets.includes(min)) {
        db.data.reminderOffsets.push(min);
        db.data.reminderOffsets.sort((a, b) => b - a);
        await db.write();
        bootstrapSchedules();
        return interaction.reply(`✅ **${min}分前** を追加（現在: ${db.data.reminderOffsets.join(', ')}分前）`);
      }
      return interaction.reply(`ℹ️ **${min}分前** はすでに設定されています`);
    }

    case 'remove-reminder-offset': {
      const min = interaction.options.getInteger('minutes');
      const idx = (db.data.reminderOffsets ?? []).indexOf(min);
      if (idx !== -1) {
        db.data.reminderOffsets.splice(idx, 1);
        await db.write();
        bootstrapSchedules();
        return interaction.reply(`✅ **${min}分前** を削除（現在: ${db.data.reminderOffsets.join(', ')}分前）`);
      }
      return interaction.reply(`ℹ️ **${min}分前** は設定されていません`);
    }

    case 'list-reminder-offsets': {
      const o = db.data.reminderOffsets ?? [];
      return interaction.reply(o.length === 0 ? '📭 未設定' : `⏰ 現在: **${o.join(', ')}分前**`);
    }

    case 'week-events': {
      await interaction.deferReply();
      const guild  = await client.guilds.fetch(GUILD_ID);
      const events = await fetchWeekEvents(guild);
      if (events.size === 0) return interaction.editReply('📭 今後1週間のイベントはありません');
      let msg = '📆 今後1週間のイベント一覧:\n';
      const sorted = [...events.values()].sort((a, b) => a.scheduledStartTimestamp - b.scheduledStartTimestamp);
      for (const e of sorted) {
        const ts = new Date(e.scheduledStartTimestamp).toLocaleString('ja-JP', { weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });
        msg += `• ${e.name} / ${ts}\n`;
      }
      return replyLong(interaction, msg);
    }

    case 'sync-calendar': {
      if (!calendarEnabled) return interaction.reply('⚠️ Calendar未設定');
      await interaction.deferReply({ flags: 64 });
      await syncAllEventsToCalendar();
      return interaction.editReply('✅ 同期完了');
    }

    case 'force-remind': {
      await interaction.deferReply({ flags: 64 });
      await sendMorningSummary(true);
      return interaction.editReply('✅ 送信しました（@everyoneあり）');
    }

    case 'n-force-remind': {
      await interaction.deferReply({ flags: 64 });
      await sendMorningSummary(false);
      return interaction.editReply('✅ 送信しました（@everyoneなし）');
    }

    case 'connection-change': {
      const isAdmin = interaction.member?.permissions?.has?.('Administrator') ?? false;
      if (!isAdmin) return interaction.reply({ content: '⛔ 権限がありません', flags: 64 });
      await interaction.deferReply({ flags: 64 });
      const text = interaction.options.getString('serial-number');
      try {
        const ch = await client.channels.fetch(interaction.options.getChannel('channel').id);
        await ch.send(text);
        return interaction.editReply('✅ 接続設定を変更しました');
      } catch (e) { return interaction.editReply(`❌ 失敗: ${e.message}`); }
    }

    case 'random-katakana': {
      const len = interaction.options.getInteger('length');
      return interaction.reply(`${interaction.user.username} さんがコマンドを実行しました\n${generateRandomKatakana(len)}`);
    }

    case 'gif-random': {
      if (!KLIPY_API_KEY) return interaction.reply('⚠️ KLIPY_API_KEYが未設定です');
      await interaction.deferReply();
      try {
        const url = await getRandomGif();
        if (!url) return interaction.editReply('❌ GIFを取得できませんでした');
        return interaction.editReply(url);
      } catch (e) { return interaction.editReply(`❌ エラー: ${e.message}`); }
    }

    case 'gif-category': {
      if (!KLIPY_API_KEY) return interaction.reply('⚠️ KLIPY_API_KEYが未設定です');
      await interaction.deferReply();
      const cat = interaction.options.getString('category');
      try {
        const url = await getRandomGifByCategory(cat);
        if (!url) return interaction.editReply('❌ GIFを取得できませんでした');
        return interaction.editReply(url);
      } catch (e) { return interaction.editReply(`❌ エラー: ${e.message}`); }
    }

    case 'exclude-user-add': {
      const user = interaction.options.getUser('user');
      db.data.vcExcludeUsers ??= [];
      if (!db.data.vcExcludeUsers.includes(user.id)) {
        db.data.vcExcludeUsers.push(user.id);
        await db.write();
        return interaction.reply(`✅ ${user.username} を除外リストに追加しました`);
      }
      return interaction.reply(`ℹ️ すでに登録されています`);
    }

    case 'exclude-user-remove': {
      const user = interaction.options.getUser('user');
      const idx = (db.data.vcExcludeUsers ?? []).indexOf(user.id);
      if (idx !== -1) { db.data.vcExcludeUsers.splice(idx, 1); await db.write(); return interaction.reply(`✅ 除外リストから削除しました`); }
      return interaction.reply(`ℹ️ 登録されていません`);
    }

    case 'exclude-user-list': {
      const ids = db.data.vcExcludeUsers ?? [];
      if (ids.length === 0) return interaction.reply('📭 除外リストは空です');
      await interaction.deferReply();
      const guild = await client.guilds.fetch(GUILD_ID);
      const names = [];
      for (const id of ids) {
        const m = await guild.members.fetch(id).catch(() => null);
        names.push(m ? `・${m.displayName} (${id})` : `・不明 (${id})`);
      }
      return replyLong(interaction, `📋 除外ユーザー一覧 (${ids.length}名):\n${names.join('\n')}`);
    }

    case 'exclude-user-export': {
      const buf = Buffer.from(JSON.stringify({ vcExcludeUsers: db.data.vcExcludeUsers ?? [] }, null, 2), 'utf-8');
      return interaction.reply({ content: '📤 エクスポートしました', files: [new AttachmentBuilder(buf, { name: 'exclude-users.json' })], flags: 64 });
    }

    case 'exclude-user-import': {
      const att = interaction.options.getAttachment('file');
      await interaction.deferReply();
      try {
        const json = await (await fetch(att.url)).json();
        if (!Array.isArray(json.vcExcludeUsers)) return interaction.editReply('❌ 形式が正しくありません');
        db.data.vcExcludeUsers = json.vcExcludeUsers;
        await db.write();
        return interaction.editReply(`✅ インポートしました（${json.vcExcludeUsers.length}名）`);
      } catch (e) { return interaction.editReply(`❌ 失敗: ${e.message}`); }
    }

    case 'tm': {
      if (!calendarEnabled) return interaction.reply('⚠️ Calendar未設定');
      const month = interaction.options.getInteger('month');
      const day   = interaction.options.getInteger('day');
      const parsed = parseHHMM(interaction.options.getString('time'));
      if (!parsed) return interaction.reply({ content: '❌ 時刻は HH:MM 形式（例: 20:00）で指定してください', flags: 64 });
      const [h]   = parsed;
      const year  = resolveYear(month, day);
      if (!isValidDate(year, month, day)) return interaction.reply({ content: `❌ ${month}/${day} は存在しない日付です`, flags: 64 });
      await interaction.deferReply();
      const target = { year, month, day };
      const weekday = getWeekday(target.year, target.month, target.day);
      const label = `**${month}/${day}(${weekday}) ${h}:00**`;
      const results = await queryMemberCalendars(target, h);
      return interaction.editReply(formatCalendarResults(results, label));
    }

    case 'tm-week': {
      if (!calendarEnabled) return interaction.reply('⚠️ Calendar未設定');
      const parsed = parseHHMM(interaction.options.getString('time'));
      if (!parsed) return interaction.reply({ content: '❌ 時刻は HH:MM 形式（例: 20:00）で指定してください', flags: 64 });
      const [h] = parsed;
      await interaction.deferReply();
      const today = nowJstParts();
      let msg = '';
      for (let i = 0; i < 7; i++) {
        const d = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
        const target = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
        const weekday = getWeekday(target.year, target.month, target.day);
        const label = `**${target.month}/${target.day}(${weekday}) ${h}:00**`;
        const results = await queryMemberCalendars(target, h);
        msg += formatCalendarResults(results, label) + '\n\n';
      }
      return replyLong(interaction, msg.trim());
    }

    case 'cal-add': {
      if (!calendarEnabled) return interaction.reply('⚠️ Calendar未設定');
      const memberCfg = MEMBER_CONFIG[interaction.user.id];
      if (!memberCfg) return interaction.reply({ content: '⚠️ あなたのカレンダーが設定されていません', flags: 64 });

      const month     = interaction.options.getInteger('month');
      const day       = interaction.options.getInteger('day');
      const startTime = interaction.options.getString('start-time');
      const endTime   = interaction.options.getString('end-time');
      const rawTitle  = interaction.options.getString('title') || '予定';
      const title     = `${memberCfg.label}${rawTitle}`;

      const startParsed = parseHHMM(startTime);
      const endParsed   = parseHHMM(endTime);
      if (!startParsed || !endParsed) return interaction.reply({ content: '❌ 時刻は HH:MM 形式（例: 19:00）で指定してください', flags: 64 });
      const year = resolveYear(month, day);
      if (!isValidDate(year, month, day)) return interaction.reply({ content: `❌ ${month}/${day} は存在しない日付です`, flags: 64 });

      const startDt = jstDate(year, month, day, ...startParsed);
      let   endDt   = jstDate(year, month, day, ...endParsed);
      // 終了が開始以前なら日付をまたぐ予定として翌日扱い（例: 23:00〜01:00）
      const overnight = endDt <= startDt;
      if (overnight) endDt = new Date(endDt.getTime() + 24 * 60 * 60 * 1000);

      await interaction.deferReply();
      try {
        await calendar.events.insert({
          calendarId: memberCfg.calendarId,
          resource: {
            summary: title,
            start: { dateTime: startDt.toISOString(), timeZone: 'Asia/Tokyo' },
            end:   { dateTime: endDt.toISOString(),   timeZone: 'Asia/Tokyo' },
          },
        });
        return interaction.editReply(`✅ 「${title}」を ${year}/${month}/${day} ${startTime}〜${overnight ? '翌' : ''}${endTime} に追加しました`);
      } catch (e) { return interaction.editReply(`❌ 追加失敗: ${e.message}`); }
    }

    case 'cal-add-allday': {
      if (!calendarEnabled) return interaction.reply('⚠️ Calendar未設定');
      const memberCfg = MEMBER_CONFIG[interaction.user.id];
      if (!memberCfg) return interaction.reply({ content: '⚠️ カレンダーが設定されていません', flags: 64 });

      const sm       = interaction.options.getInteger('start-month');
      const sd       = interaction.options.getInteger('start-day');
      const em       = interaction.options.getInteger('end-month');
      const ed       = interaction.options.getInteger('end-day');
      const rawTitle = interaction.options.getString('title') || '予定';
      const title    = `${memberCfg.label}${rawTitle}`;
      const year     = resolveYear(sm, sd);
      // 終了月日が開始より前なら年をまたぐ予定（例: 12/30〜1/2）
      const endYear  = Date.UTC(year, em - 1, ed) < Date.UTC(year, sm - 1, sd) ? year + 1 : year;
      if (!isValidDate(year, sm, sd) || !isValidDate(endYear, em, ed)) {
        return interaction.reply({ content: '❌ 存在しない日付が指定されています', flags: 64 });
      }

      // 終日予定の終了日はGoogle Calendar的に「翌日」を指定
      const endDate = new Date(Date.UTC(endYear, em - 1, ed + 1));
      const endDateStr = `${endDate.getUTCFullYear()}-${String(endDate.getUTCMonth()+1).padStart(2,'0')}-${String(endDate.getUTCDate()).padStart(2,'0')}`;
      const startDateStr = `${year}-${String(sm).padStart(2,'0')}-${String(sd).padStart(2,'0')}`;

      await interaction.deferReply();
      try {
        await calendar.events.insert({
          calendarId: memberCfg.calendarId,
          resource: {
            summary: title,
            start: { date: startDateStr },
            end:   { date: endDateStr },
          },
        });
        return interaction.editReply(`✅ 「${title}」を ${year}/${sm}/${sd}〜${endYear}/${em}/${ed} の終日予定として追加しました`);
      } catch (e) { return interaction.editReply(`❌ 追加失敗: ${e.message}`); }
    }

    case 'cal-delete': {
      if (!calendarEnabled) return interaction.reply('⚠️ Calendar未設定');
      const memberCfg = MEMBER_CONFIG[interaction.user.id];
      if (!memberCfg) return interaction.reply({ content: '⚠️ カレンダーが設定されていません', flags: 64 });

      const weeks = interaction.options.getInteger('weeks');
      const today = nowJstParts();
      const timeMin = jstDate(today.year, today.month, today.day);
      const timeMax = new Date(timeMin.getTime() + weeks * 7 * 24 * 60 * 60 * 1000);

      await interaction.deferReply();
      try {
        // リアクションで選べるのは10件まで
        const res = await calendar.events.list({
          calendarId: memberCfg.calendarId,
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 10,
        });
        const events = res.data.items ?? [];

        const numberEmojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];

        if (events.length === 0) return interaction.editReply('📭 予定がありません');

        let msg = `📋 ${weeks}週間以内の予定一覧:\n`;
        events.forEach((ev, i) => {
          const isAllDay = !ev.start.dateTime;
          if (isAllDay) {
            msg += `${i+1}. 【終日】${ev.summary} (${ev.start.date})\n`;
          } else {
            const start = new Date(ev.start.dateTime).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });
            const end   = new Date(ev.end.dateTime).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });
            msg += `${i+1}. ${ev.summary} (${start}〜${end})\n`;
          }
        });
        if (res.data.nextPageToken) msg += '（11件目以降は表示されません。期間を短くしてください）\n';
        msg += '\n数字リアクションで削除する予定を選択してください。❌でキャンセル。';

        const sentMsg = await interaction.editReply({ content: msg });

        // リアクションを付け終わる前に押されても反応できるよう、先にセッションを保存する
        db.data.pendingDeleteSessions[interaction.user.id] = {
          msgId: sentMsg.id,
          requesterId: interaction.user.id,
          events: events.map(ev => ({ id: ev.id, summary: ev.summary })),
          calendarId: memberCfg.calendarId,
        };
        await db.write();

        await sentMsg.react('❌');
        for (let i = 0; i < events.length; i++) {
          await sentMsg.react(numberEmojis[i]);
        }
      } catch (e) {
        return interaction.editReply(`❌ 取得失敗: ${e.message}`).catch(() => {});
      }
      break;
    }

    case 'debug-events': {
      await interaction.deferReply({ flags: 64 });
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const all   = await guild.scheduledEvents.fetch();
        if (all.size === 0) return interaction.editReply('📭 現在把握しているイベントはありません');
        let msg = `🔍 **Bot把握イベント一覧** (${all.size}件)\n\n`;
        for (const e of all.values()) {
          const startJst = new Date(e.scheduledStartTimestamp).toLocaleString('ja-JP', {
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo'
          });
          const statusMap = { 1: '予定', 2: '開催中', 3: '完了', 4: 'キャンセル' };
          const status = statusMap[e.status] ?? '不明';
          const roleId = db.data.eventRoles[e.id];
          let members = '（なし）';
          if (roleId) {
            const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
            if (role && role.members.size > 0) members = [...role.members.values()].map(m => m.displayName).join(', ');
          }
          const reminders = [];
          for (const [desc] of jobMap.entries()) {
            if (desc.startsWith(`${EVENT_JOB_PREFIX}${e.id}:reminder:`)) {
              const offsetMin = parseInt(desc.split(':')[3], 10);
              const reminderTime = new Date(e.scheduledStartTimestamp - offsetMin * 60000);
              const reminderJst = reminderTime.toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });
              reminders.push(`${offsetMin}分前 (${reminderJst})`);
            }
          }
          msg += `**◆ ${e.name}**\n　状態: ${status}\n　開催: ${startJst}\n　参加予定: ${members}\n　リマインド: ${reminders.length > 0 ? reminders.join(', ') : '（未登録）'}\n\n`;
        }
        return replyLong(interaction, msg);
      } catch (e) { return interaction.editReply(`❌ エラー: ${e.message}`); }
    }

    case 'dice': {
      const faces = interaction.options.getInteger('faces');
      const count = interaction.options.getInteger('count');
      const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * faces) + 1);
      const total = rolls.reduce((a, b) => a + b, 0);
      let msg = `🎲 **${interaction.user.displayName}** が **${count}d${faces}** を振りました！\n`;
      msg += count === 1 ? `結果: **${rolls[0]}**` : `結果: ${rolls.join(', ')}\n合計: **${total}**`;
      // 面数が大きいと100個で2000文字を超えるので合計だけにする
      if (msg.length > 2000) msg = `🎲 **${interaction.user.displayName}** が **${count}d${faces}** を振りました！\n合計: **${total}**（出目が多すぎるため個別表示は省略）`;
      return interaction.reply(msg);
    }

    case 'anonymous': {
      const targetChannel = interaction.options.getChannel('channel');
      const message = interaction.options.getString('message');
      console.log(`📨 匿名メッセージ: ${interaction.user.username} (${interaction.user.id}) → #${targetChannel.name} : "${message}"`);
      await interaction.deferReply({ flags: 64 });
      try {
        const ch = await client.channels.fetch(targetChannel.id);
        await ch.send(`🕵️ 誰かが匿名メッセージを送信しました\n${message}`);
        return interaction.editReply('✅ 匿名メッセージを送信しました');
      } catch (e) { return interaction.editReply(`❌ 送信失敗: ${e.message}`); }
    }

    case 'version': {
      return interaction.reply(`🤖 TKイベントリマインダーBot **v${BOT_VERSION}**`);
    }

    case 'state-export': {
      const isAdmin = interaction.member?.permissions?.has?.('Administrator') ?? false;
      if (!isAdmin) return interaction.reply({ content: '⛔ 管理者専用です', flags: 64 });
      const state = {
        exportedAt: new Date().toISOString(),
        version: BOT_VERSION,
        morningTime: db.data.morningTime,
        reminderOffsets: db.data.reminderOffsets,
        eventMap: db.data.eventMap,
        eventRoles: db.data.eventRoles,
        reminderMsgMap: db.data.reminderMsgMap,
        lastReminderMsgIds: db.data.lastReminderMsgIds,
        vcExcludeUsers: db.data.vcExcludeUsers,
        activeVcSessions: db.data.activeVcSessions,
        pendingDeleteSessions: db.data.pendingDeleteSessions,
        saylaterJobs: db.data.saylaterJobs,
        gjData: db.data.gjData,
        channelSnapshot: db.data.channelSnapshot,
      };
      const buf = Buffer.from(JSON.stringify(state, null, 2), 'utf-8');
      const filename = `bot-state-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`;
      return interaction.reply({
        content: `✅ 状態をエクスポートしました（${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}）`,
        files: [new AttachmentBuilder(buf, { name: filename })],
        flags: 64
      });
    }

    case 'state-import': {
      const isAdmin = interaction.member?.permissions?.has?.('Administrator') ?? false;
      if (!isAdmin) return interaction.reply({ content: '⛔ 管理者専用です', flags: 64 });
      await interaction.deferReply({ flags: 64 });
      const att = interaction.options.getAttachment('file');
      try {
        const json = await (await fetch(att.url)).json();
        if (!json.version || !json.exportedAt) return interaction.editReply('❌ 正しいエクスポートファイルではありません');
        if (json.morningTime)                    db.data.morningTime           = json.morningTime;
        if (Array.isArray(json.reminderOffsets)) db.data.reminderOffsets       = json.reminderOffsets;
        if (json.eventMap)                       db.data.eventMap              = json.eventMap;
        if (json.eventRoles)                     db.data.eventRoles            = json.eventRoles;
        if (json.reminderMsgMap)                 db.data.reminderMsgMap        = json.reminderMsgMap;
        if (Array.isArray(json.lastReminderMsgIds)) db.data.lastReminderMsgIds = json.lastReminderMsgIds;
        if (Array.isArray(json.vcExcludeUsers))  db.data.vcExcludeUsers        = json.vcExcludeUsers;
        if (json.activeVcSessions)               db.data.activeVcSessions      = json.activeVcSessions;
        if (json.pendingDeleteSessions)          db.data.pendingDeleteSessions  = json.pendingDeleteSessions;
        if (json.saylaterJobs)                   db.data.saylaterJobs           = json.saylaterJobs;
        if (json.channelSnapshot) db.data.channelSnapshot = json.channelSnapshot;
        // gjDataは完全に置き換え（ファイルに無い場合は現在のデータを残す）
        if (json.gjData) {
          db.data.gjData = json.gjData;
          initGjData(db);
        }
        await db.write();
        bootstrapSchedules();
        const exportedAt = new Date(json.exportedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        return interaction.editReply(
          `✅ 状態をインポートしました\n　エクスポート日時: ${exportedAt}\n` +
          `　イベント記録: ${Object.keys(json.eventMap ?? {}).length}件\n` +
          `　ロール記録: ${Object.keys(json.eventRoles ?? {}).length}件\n` +
          `　リマインドメッセージ: ${(json.lastReminderMsgIds ?? []).length}件\n` +
          `　除外ユーザー: ${(json.vcExcludeUsers ?? []).length}名\n` +
          `　GJ履歴: ${(json.gjData?.history ?? []).length}件\n` +
          `　伝言予約: ${Object.keys(json.saylaterJobs ?? {}).length}件\n\n` +
          `cronを再登録しました。リマインド収集はそのまま継続されます。`
        );
      } catch (e) { return interaction.editReply(`❌ インポート失敗: ${e.message}`); }
    }

    case 'goodjob': {
      const target    = interaction.options.getUser('target');
      const reason    = interaction.options.getString('reason') ?? null;
      const anonymous = interaction.options.getBoolean('anonymous') ?? false;
      if (anonymous) {
        console.log(`👍 匿名GJ送信: ${interaction.user.username} (${interaction.user.id}) → ${target.username} (${target.id})`);
      }
      if (target.bot) return interaction.reply({ content: '❌ Botにはグッジョブを送れません', flags: 64 });
      // 実績・コンボ通知などで3秒を超えることがあるので先に応答を保留する
      await interaction.deferReply({ flags: 64 });
      const guild      = await client.guilds.fetch(GUILD_ID);
      const fromMember = await guild.members.fetch(interaction.user.id).catch(() => null);
      const toMember   = await guild.members.fetch(target.id).catch(() => null);
      if (!fromMember || !toMember) return interaction.editReply('❌ ユーザーが見つかりません');
      const ch = await client.channels.fetch(interaction.channelId);
      const result = await sendGoodJob(db, client, GUILD_ID, {
        fromId: interaction.user.id, fromName: fromMember.displayName,
        toId: target.id, toName: toMember.displayName,
        reason, anonymous, channel: ch
      });
      if (!result.success) return interaction.editReply(result.reason);
      return interaction.editReply('✅ グッジョブを送信しました！');
    }

    case 'goodjob-history': {
      const target = interaction.options.getUser('target') ?? interaction.user;
      const now    = Date.now();
      const days30 = 30 * 24 * 60 * 60 * 1000;
      const recent = (db.data.gjData.history ?? []).filter(h =>
        h.to === target.id && now - new Date(h.timestamp).getTime() < days30
      );
      const total  = (db.data.gjData.history ?? []).filter(h => h.to === target.id).length;
      const points = getGjPoints(db, target.id);
      let msg = `📊 **${target.displayName ?? target.username}** のグッジョブ履歴
`;
      msg += `過去30日で **${recent.length}回** のグッジョブを受けています（累計: ${total}回 / GJP: ${points.gjp}）
`;
      const reasons = recent.filter(h => h.reason).slice(-5).map(h => `・${h.reason}`);
      if (reasons.length > 0) msg += `\n最近の理由：\n${reasons.join('\n')}`;
      return interaction.reply({ content: msg, flags: 64 });
    }

    case 'goodjob-status': {
      const userId = interaction.user.id;
      const points = getGjPoints(db, userId);
      const mc     = db.data.gjData.monthlyCounters?.[userId] ?? { monthlyGjp: 0, monthlyGsp: 0 };
      const ach    = db.data.gjData.achievements?.[userId] ?? { received: [], sent: [] };

      const achLabels = {
        received: { first: '🌱 初GJ', '10': '👍 GJ 10回', '100': '🔥 GJ 100回', '500': '👑 GJ 500回', '10src': '💎 10人以上からGJ', '7streak': '🌟 7日連続GJ' },
        sent:     { first: '🤝 初GJ送信', '10tgt': '❤️ 10人にGJ', '20tgt': '🌎 20人以上にGJ', '10day': '🫂 1日10GJ' },
      };

      const receivedAch = ach.received.map(k => achLabels.received[k] ?? k).join('、') || '（なし）';
      const sentAch     = ach.sent.map(k => achLabels.sent[k] ?? k).join('、') || '（なし）';

      const now = Date.now();
      const history = db.data.gjData.history ?? [];
      const received30 = history.filter(h => h.to === userId && now - new Date(h.timestamp).getTime() < 30 * 24 * 60 * 60 * 1000).length;
      const sent30     = history.filter(h => h.from === userId && !h.anonymous && now - new Date(h.timestamp).getTime() < 30 * 24 * 60 * 60 * 1000).length;

      const msg = [
        `📊 **${interaction.user.displayName ?? interaction.user.username}** のGJステータス`,
        '',
        `**📈 累計**`,
        `　GJP（受け取り）: ${points.gjp}`,
        `　GSP（送り）: ${points.gsp}`,
        '',
        `**📅 今月**`,
        `　GJP: ${mc.monthlyGjp}　GSP: ${mc.monthlyGsp}`,
        '',
        `**📆 過去30日**`,
        `　受け取ったGJ: ${received30}回　送ったGJ: ${sent30}回`,
        '',
        `**🏆 解除済み実績**`,
        `　受け取り側: ${receivedAch}`,
        `　送り側: ${sentAch}`,
      ].join('\n');

      return interaction.reply({ content: msg, flags: 64 });
    }

    case 'goodjob-ranking': {
      const points = db.data.gjData.points ?? {};
      const sorted = Object.entries(points).sort((a,b) => b[1].gjp - a[1].gjp).slice(0, 10);
      if (sorted.length === 0) return interaction.reply('📭 まだグッジョブの記録がありません');
      await interaction.deferReply();
      const guild = await client.guilds.fetch(GUILD_ID);
      let msg = `🏆 **グッジョブランキング**

`;
      const medals = ['🥇','🥈','🥉'];
      for (let i = 0; i < sorted.length; i++) {
        const [uid, pts] = sorted[i];
        const m = await guild.members.fetch(uid).catch(() => null);
        const name = m?.displayName ?? uid;
        const medal = medals[i] ?? `${i+1}.`;
        msg += `${medal} **${name}** - ${pts.gjp} GJP / ${pts.gsp} GSP
`;
      }
      return interaction.editReply(msg);
    }

    case 'saylatter-list': {
      const jobs = Object.entries(db.data.saylaterJobs ?? {});
      if (jobs.length === 0) return interaction.reply({ content: '📭 設定中の伝言予約はありません', flags: 64 });
      let msg = `📬 **伝言予約一覧** (${jobs.length}件)\n\n`;
      jobs.forEach(([id, job], i) => {
        const fireAtJst = new Date(job.fireAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        msg += `${i+1}. ⏰ ${fireAtJst}\n　📝 ${job.message.slice(0, 30)}${job.message.length > 30 ? '…' : ''}\n　👤 <@${job.mentionId}> → <#${job.channelId}>\n\n`;
      });
      msg += '`/saylatter-cancel number:番号` でキャンセルできます';
      return interaction.reply({ content: msg, flags: 64 });
    }

    case 'saylatter-cancel': {
      const number = interaction.options.getInteger('number');
      const jobs = Object.entries(db.data.saylaterJobs ?? {});
      if (jobs.length === 0) return interaction.reply({ content: '📭 設定中の伝言予約はありません', flags: 64 });
      if (number > jobs.length) return interaction.reply({ content: `❌ 番号 ${number} の予約は存在しません（現在${jobs.length}件）`, flags: 64 });
      const [id, job] = jobs[number - 1];
      const fireAtJst = new Date(job.fireAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      // cronを停止
      stopJob(`simple-remind:${id}`);
      // DBから削除
      delete db.data.saylaterJobs[id];
      await db.write();
      return interaction.reply({ content: `✅ 伝言予約をキャンセルしました\n　⏰ ${fireAtJst}\n　📝 ${job.message}`, flags: 64 });
    }

    case 'saylatter-rel': {
      const value   = interaction.options.getInteger('value');
      const unit    = interaction.options.getString('unit');
      const message = interaction.options.getString('message');
      const mentionUser     = interaction.options.getUser('mention') ?? interaction.user;
      const targetChannel   = interaction.options.getChannel('channel');
      const targetChannelId = targetChannel?.id ?? DEFAULT_REMIND_CHANNEL_ID;

      const msMap    = { minutes: 60 * 1000, hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000 };
      const unitLabel = { minutes: '分', hours: '時間', days: '日' };
      const fireAt   = new Date(Date.now() + value * msMap[unit]);
      // cron式は年を指定できないので1年以内に制限
      if (fireAt.getTime() - Date.now() > 365 * 24 * 60 * 60 * 1000) {
        return interaction.reply({ content: '❌ 伝言予約は1年以内で指定してください', flags: 64 });
      }
      const fireAtJst = fireAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

      // DBに保存して継承できるようにする
      db.data.saylaterJobs[interaction.id] = {
        fireAt: fireAt.toISOString(),
        message,
        mentionId: mentionUser.id,
        channelId: targetChannelId,
      };
      await db.write();
      scheduleSaylaterJob(interaction.id);

      return interaction.reply({
        content: `✅ 伝言予約を設定しました\n　⏰ ${value}${unitLabel[unit]}後 (${fireAtJst})\n　📝 ${message}\n　👤 ${mentionUser.displayName ?? mentionUser.username}\n　📍 <#${targetChannelId}>`,
      });
    }

    case 'saylatter-abs': {
      const month   = interaction.options.getInteger('month');
      const day     = interaction.options.getInteger('day');
      const time    = interaction.options.getString('time');
      const message = interaction.options.getString('message');
      const mentionUser     = interaction.options.getUser('mention') ?? interaction.user;
      const targetChannel   = interaction.options.getChannel('channel');
      const targetChannelId = targetChannel?.id ?? DEFAULT_REMIND_CHANNEL_ID;

      const parsed = parseHHMM(time);
      if (!parsed) return interaction.reply({ content: '❌ 時刻は HH:MM 形式（例: 20:00）で指定してください', flags: 64 });
      // 今日より前の月日は来年として扱う（12月に1月の予約をする場合など）
      const year = resolveYear(month, day);
      if (!isValidDate(year, month, day)) return interaction.reply({ content: `❌ ${month}/${day} は存在しない日付です`, flags: 64 });
      const fireAt = jstDate(year, month, day, ...parsed);

      if (fireAt <= Date.now()) {
        return interaction.reply({ content: '❌ 指定した日時はすでに過去です', flags: 64 });
      }

      const fireAtJst = fireAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

      // DBに保存して継承できるようにする
      db.data.saylaterJobs[interaction.id] = {
        fireAt: fireAt.toISOString(),
        message,
        mentionId: mentionUser.id,
        channelId: targetChannelId,
      };
      await db.write();
      scheduleSaylaterJob(interaction.id);

      return interaction.reply({
        content: `✅ 伝言予約を設定しました\n　⏰ ${month}/${day} ${time} (${fireAtJst})\n　📝 ${message}\n　👤 ${mentionUser.displayName ?? mentionUser.username}\n　📍 <#${targetChannelId}>`,
      });
    }

    case 'activity-save': {
      await interaction.deferReply({ flags: 64 });
      try {
        const guild    = await client.guilds.fetch(GUILD_ID);
        const channels = await guild.channels.fetch();
        const snapshot = {};
        const now      = new Date().toISOString();

        for (const ch of channels.values()) {
          if (!ch) continue;
          if (ch.type !== 0 && ch.type !== 5 && ch.type !== 15) continue;
          try {
            const messages = await ch.messages.fetch({ limit: 1 });
            const last     = messages.first();
            snapshot[ch.id] = {
              name: ch.name, lastMessageId: last?.id ?? null,
              lastMessageAt: last?.createdAt?.toISOString() ?? null, messageCount: 0,
            };
          } catch (e) {}
          if (ch.threads) {
            const threads = await ch.threads.fetchActive().catch(() => null);
            if (threads) {
              for (const thread of threads.threads.values()) {
                try {
                  const msgs = await thread.messages.fetch({ limit: 1 });
                  const last = msgs.first();
                  snapshot[thread.id] = {
                    name: `#${ch.name} > ${thread.name}`, lastMessageId: last?.id ?? null,
                    lastMessageAt: last?.createdAt?.toISOString() ?? null, messageCount: 0,
                  };
                } catch (e) {}
              }
            }
          }
        }
        db.data.channelSnapshot = { savedAt: now, channels: snapshot };
        await db.write();
        const savedAtJst = new Date(now).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        return interaction.editReply(`✅ アクティビティを記録しました\n　保存日時: ${savedAtJst}\n　記録チャンネル数: ${Object.keys(snapshot).length}件`);
      } catch (e) { return interaction.editReply(`❌ エラー: ${e.message}`); }
    }

    case 'activity-check': {
      await interaction.deferReply({ flags: 64 });
      try {
        const snapshot = db.data.channelSnapshot;
        if (!snapshot?.savedAt) return interaction.editReply('⚠️ まだ記録がありません。先に `/activity-save` を実行してください。');
        const guild    = await client.guilds.fetch(GUILD_ID);
        const channels = await guild.channels.fetch();
        const savedAtJst = new Date(snapshot.savedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        const updated = [];
        for (const ch of channels.values()) {
          if (!ch) continue;
          if (ch.type !== 0 && ch.type !== 5 && ch.type !== 15) continue;
          const checkCh = async (channel, displayName) => {
            try {
              const saved = snapshot.channels[channel.id];
              const msgs  = await channel.messages.fetch({ limit: 1 });
              const last  = msgs.first();
              if (!last) return;
              if (!saved || last.id !== saved.lastMessageId) {
                let count = 0;
                if (saved?.lastMessageId) {
                  const newMsgs = await channel.messages.fetch({ limit: 100, after: saved.lastMessageId }).catch(() => null);
                  count = newMsgs?.size ?? 1;
                } else { count = 1; }
                const lastAtJst = last.createdAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });
                updated.push({ name: displayName, count, lastAt: lastAtJst, ts: last.createdTimestamp });
              }
            } catch (e) {}
          };
          await checkCh(ch, `#${ch.name}`);
          if (ch.threads) {
            const threads = await ch.threads.fetchActive().catch(() => null);
            if (threads) {
              for (const thread of threads.threads.values()) {
                await checkCh(thread, `#${ch.name} > ${thread.name}`);
              }
            }
          }
        }
        if (updated.length === 0) return interaction.editReply(`📭 **${savedAtJst}** 以降に更新のあったチャンネルはありません`);
        updated.sort((a, b) => b.ts - a.ts);
        let msg = `📊 **${savedAtJst}** から更新のあったチャンネル (${updated.length}件):\n\n`;
        for (const u of updated.slice(0, 25)) {
          msg += `**${u.name}**　新規 ${u.count}件　最終更新：${u.lastAt}\n`;
        }
        if (updated.length > 25) msg += `\n…他 ${updated.length - 25}件`;
        return interaction.editReply(msg.slice(0, 2000));
      } catch (e) { return interaction.editReply(`❌ エラー: ${e.message}`); }
    }

    case 'purge': {
      const isAdmin = interaction.member?.permissions?.has?.('Administrator') ?? false;
      if (!isAdmin) return interaction.reply({ content: '⛔ 管理者専用です', flags: 64 });
      const value       = interaction.options.getInteger('value');
      const unit        = interaction.options.getString('unit');
      const excludeUser = interaction.options.getUser('exclude-user');
      const onlyUser    = interaction.options.getUser('only-user');
      const matchText   = interaction.options.getString('match-text');
      const matchType   = interaction.options.getString('match-type') ?? 'partial';
      const msMap       = { minutes: 60 * 1000, hours: 60 * 60 * 1000 };
      const cutoff      = new Date(Date.now() - value * msMap[unit]);
      const cutoffJst   = cutoff.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
      await interaction.deferReply({ flags: 64 });
      try {
        const channel = interaction.channel;
        let allMessages = [];
        let lastId = null;
        for (let i = 0; i < 5; i++) {
          const opts = { limit: 100 };
          if (lastId) opts.before = lastId;
          const batch = await channel.messages.fetch(opts);
          const filtered = [...batch.values()].filter(m => m.createdAt >= cutoff);
          allMessages.push(...filtered);
          if (filtered.length < batch.size || batch.size < 100) break;
          lastId = batch.last()?.id;
        }
        let targets = allMessages;
        if (onlyUser)    targets = targets.filter(m => m.author.id === onlyUser.id);
        if (excludeUser) targets = targets.filter(m => m.author.id !== excludeUser.id);
        if (matchText)   targets = targets.filter(m => matchType === 'exact' ? m.content === matchText : m.content.includes(matchText));
        if (targets.length === 0) return interaction.editReply('📭 削除対象のメッセージがありませんでした');
        const oldest     = [...targets].sort((a, b) => a.createdTimestamp - b.createdTimestamp)[0];
        const confirmMsg = await oldest.reply({
          content: `**${cutoffJst}** までのメッセージを **${targets.length}件** 削除しますか？\n✅ で削除、❌ でキャンセル`,
          allowedMentions: { repliedUser: false }
        });
        await confirmMsg.react('✅');
        await confirmMsg.react('❌');
        await interaction.editReply('確認メッセージを送信しました');
        const filter    = (r, u) => ['✅','❌'].includes(r.emoji.name) && u.id === interaction.user.id;
        const collected = await confirmMsg.awaitReactions({ filter, max: 1, time: 60000 }).catch(() => null);
        const reaction  = collected?.first();
        if (!reaction || reaction.emoji.name === '❌') {
          await confirmMsg.edit('🚫 削除をキャンセルしました');
          return;
        }
        await confirmMsg.edit(`🗑️ ${targets.length}件のメッセージを削除中...`);
        const now14  = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
        const bulk   = targets.filter(m => m.createdAt > now14 && m.id !== confirmMsg.id);
        const single = targets.filter(m => m.createdAt <= now14 && m.id !== confirmMsg.id);
        // 実際に削除できた件数だけ数える
        let deleted = 0;
        for (let i = 0; i < bulk.length; i += 100) {
          const res = await channel.bulkDelete(bulk.slice(i, i + 100), true).catch(() => null);
          deleted += res?.size ?? 0;
        }
        let singleTried = 0;
        for (const m of single) {
          if (await m.delete().then(() => true).catch(() => false)) deleted++;
          if (++singleTried % 10 === 0) await new Promise(r => setTimeout(r, 1000));
        }
        await confirmMsg.edit(`✅ ${deleted}件のメッセージを削除しました`);
        console.log(`🗑️ purge: ${interaction.user.username} が #${channel.name} で ${deleted}件削除`);
      } catch (e) { await interaction.editReply(`❌ エラー: ${e.message}`).catch(() => {}); }
      break;
    }
  }
}

// ============================================================
// グローバルエラーハンドラー（Botのクラッシュを防ぐ）
// ============================================================
process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled rejection:', error?.message ?? error);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error?.message ?? error);
});

client.on('error', (error) => {
  console.error('❌ Discord client error:', error?.message ?? error);
});

// ============================================================
// Bot ログイン
// ============================================================
client.login(DISCORD_TOKEN);
