// index.js

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import cron from 'node-cron';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { google } from 'googleapis';
import {
  Client, IntentsBitField, REST, Routes,
  SlashCommandBuilder, AttachmentBuilder, ChannelType
} from 'discord.js';
import {
  joinVoiceChannel, getVoiceConnection
} from '@discordjs/voice';
import * as dotenv from 'dotenv';
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

async function syncAllEventsToCalendar() {
  if (!calendarEnabled) return;
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
  const windowStart = new Date(Date.UTC(target.year, target.month - 1, target.day, targetHour - 9, 0, 0, 0));
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
        results.push({ member: name, title: ev.summary, start: ev.start.dateTime ?? ev.start.date });
      }
    } catch (e) { console.error(`❌ ${name}カレンダー取得失敗:`, e.message); }
  }
  return results;
}

function formatCalendarResults(results, dateLabel) {
  if (results.length === 0) return `${dateLabel}\nこの時間の予定はありません`;
  const lines = results.map(r => {
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
    joinVoiceChannel({
      channelId: channel.id,
      guildId: GUILD_ID,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: true,
    });
    await channel.fetch();
    const initialMembers = [...channel.members.keys()].filter(id => id !== client.user.id);
    db.data.activeVcSessions[event.id] = { channelId: event.channelId, participants: initialMembers };
    await db.write();
    console.log(`🎙️ VCセッション開始: "${event.name}" (初期: ${initialMembers.length}名)`);
  } catch (e) { console.error(`❌ VCセッション開始失敗:`, e.message); }
}

async function endVcSession(eventId, eventName) {
  try {
    const connection = getVoiceConnection(GUILD_ID);
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
const jobMap = new Map();

function registerCron(expr, jobFn, desc) {
  if (jobMap.has(desc)) { jobMap.get(desc).stop(); jobMap.delete(desc); }
  console.log(`⏰ Register cron [${expr}] for ${desc}`);
  const job = cron.schedule(expr, async () => {
    console.log(`▶ Trigger [${desc}] at ${new Date().toLocaleString('ja-JP')}`);
    try { await jobFn(); } catch (e) { console.error(`❌ Job error (${desc}):`, e); }
  }, { timezone: 'Asia/Tokyo' });
  jobMap.set(desc, job);
}

function clearAllJobs() { for (const j of jobMap.values()) j.stop(); jobMap.clear(); }

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
    const chanUrl  = `https://discord.com/channels/${GUILD_ID}/${e.channelId}`;
    const eventUrl = `https://discord.com/events/${GUILD_ID}/${e.id}`;
    const msg = `## ◆${e.name}\n${time} / ${host}\n📍 チャンネル: <${chanUrl}>\n🔗 イベント:   <${eventUrl}>\n✅ 出席／❌ 欠席 で参加表明お願いします！`;
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
// 現在登録中のイベントIDセットを管理
const registeredEventIds = new Set();

async function scheduleEventReminders() {
  const guild  = await client.guilds.fetch(GUILD_ID);
  const events = await fetchTodaysEvents(guild);

  // 今日のイベントIDセット
  const todayEventIds = new Set([...events.values()].map(e => e.id));

  // 削除されたイベントのcronを停止
  for (const eventId of registeredEventIds) {
    if (!todayEventIds.has(eventId)) {
      // このイベントのcronを全部停止
      for (const [desc, job] of jobMap.entries()) {
        if (desc.includes(`'`) && desc.includes(eventId) || desc.endsWith(`'${[...events.values()].find(e => e.id === eventId)?.name ?? ''}' -60m`) ) {
          job.stop(); jobMap.delete(desc);
        }
      }
      registeredEventIds.delete(eventId);
    }
  }

  for (const offset of (db.data.reminderOffsets ?? [60, 15])) {
    for (const e of events.values()) {
      const target = new Date(e.scheduledStartTimestamp - offset * 60000);
      const jst    = new Date(target.getTime() + 9 * 60 * 60 * 1000);
      const expr   = `${jst.getUTCMinutes()} ${jst.getUTCHours()} ${jst.getUTCDate()} ${jst.getUTCMonth() + 1} *`;
      const chanUrl  = `https://discord.com/channels/${GUILD_ID}/${e.channelId}`;
      const eventUrl = `https://discord.com/events/${GUILD_ID}/${e.id}`;
      registerCron(expr, async () => {
        const g    = await client.guilds.fetch(GUILD_ID);
        // イベントがまだ存在するか確認
        const currentEvents = await g.scheduledEvents.fetch();
        if (!currentEvents.has(e.id)) return;
        const ch   = await g.channels.fetch(ANNOUNCE_CHANNEL_ID);
        const role = await getOrCreateEventRole(g, e);
        await ch.send({ content: `${role}\n⏰ **${offset}分前リマインド** 「${e.name}」\n📍 チャンネル: <${chanUrl}>\n🔗 イベント:   <${eventUrl}>`, allowedMentions: { roles: [role.id] } });
      }, `reminder '${e.name}' -${offset}m`);
      registeredEventIds.add(e.id);
    }
  }

  for (const e of events.values()) {
    const startTs  = e.scheduledStartTimestamp;
    const startJst = new Date(new Date(startTs).getTime() + 9 * 60 * 60 * 1000);
    const expr     = `${startJst.getUTCMinutes()} ${startJst.getUTCHours()} ${startJst.getUTCDate()} ${startJst.getUTCMonth() + 1} *`;
    const chanUrl  = `https://discord.com/channels/${GUILD_ID}/${e.channelId}`;
    const eventUrl = `https://discord.com/events/${GUILD_ID}/${e.id}`;

    // 開始アナウンス
    registerCron(expr, async () => {
      const g = await client.guilds.fetch(GUILD_ID);
      const currentEvents = await g.scheduledEvents.fetch();
      if (!currentEvents.has(e.id)) return;
      const ch = await g.channels.fetch(ANNOUNCE_CHANNEL_ID);
      await ch.send({ content: `@everyone\n🚀 **「${e.name}」が始まりました！**\n📍 会場: <${chanUrl}>\n🔗 イベント: <${eventUrl}>`, allowedMentions: { parse: ['everyone'] } });
    }, `start '${e.name}'`);

    // 開始3分後：未参加チェック
    const check3  = new Date(startTs + 3 * 60000);
    const jst3    = new Date(check3.getTime() + 9 * 60 * 60 * 1000);
    const expr3   = `${jst3.getUTCMinutes()} ${jst3.getUTCHours()} ${jst3.getUTCDate()} ${jst3.getUTCMonth() + 1} *`;
    registerCron(expr3, async () => {
      const g = await client.guilds.fetch(GUILD_ID);
      const currentEvents = await g.scheduledEvents.fetch();
      if (!currentEvents.has(e.id)) return;
      const ch   = await g.channels.fetch(ANNOUNCE_CHANNEL_ID);
      const role = await getOrCreateEventRole(g, e);
      const vcCh = e.channelId ? await g.channels.fetch(e.channelId).catch(() => null) : null;
      if (!vcCh) return;
      const vcIds    = new Set(vcCh.members?.keys() ?? []);
      const absentees = role.members.filter(m => !vcIds.has(m.id));
      if (absentees.size === 0) return;
      await ch.send({ content: `⚠️ 以下の出席予定者が参加していません:\n${absentees.map(m => `<@${m.id}>`).join('\n')}`, allowedMentions: { users: [...absentees.keys()] } });
    }, `absence '${e.name}' +3m`);

    // 開始5分後：まだ開始していなければ通知
    const check5  = new Date(startTs + 5 * 60000);
    const jst5    = new Date(check5.getTime() + 9 * 60 * 60 * 1000);
    const expr5   = `${jst5.getUTCMinutes()} ${jst5.getUTCHours()} ${jst5.getUTCDate()} ${jst5.getUTCMonth() + 1} *`;
    registerCron(expr5, async () => {
      const g = await client.guilds.fetch(GUILD_ID);
      const currentEvents = await g.scheduledEvents.fetch();
      const currentEvent  = currentEvents.get(e.id);
      // ACTIVE(2) でも COMPLETED(3) でもなければ未開始
      if (!currentEvent || currentEvent.status === 2 || currentEvent.status === 3) return;
      const ch = await g.channels.fetch(ANNOUNCE_CHANNEL_ID);
      await ch.send({ content: `⚠️ 「${e.name}」はまだ開始されていません` });
    }, `not-started '${e.name}' +5m`);

    registeredEventIds.add(e.id);
  }
}

function scheduleDailyReminders() {
  const [h, m] = (db.data.morningTime || '07:00').split(':');
  registerCron(`0 ${m} ${h} * * *`, () => sendMorningSummary(true), 'morning-summary');
  registerCron('0 0 * * *', scheduleEventReminders, 'daily-reschedule');
}

function bootstrapSchedules() {
  clearAllJobs();
  registeredEventIds.clear();
  scheduleDailyReminders();
  scheduleEventReminders();
  // 3分おきにCalendar同期
  registerCron('*/3 * * * *', syncAllEventsToCalendar, 'calendar-sync');
  // 1分おきにイベント状態を再確認してcronを更新
  registerCron('* * * * *', async () => {
    try { await scheduleEventReminders(); }
    catch (e) { console.error('イベント再認識エラー:', e.message); }
  }, 'event-resync');
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
  // data.media がオブジェクト形式の場合
  if (item.media && !Array.isArray(item.media)) {
    return item.media.gif?.url ?? item.media.tinygif?.url ?? item.media.mediumgif?.url ?? null;
  }
  // data.media が配列形式（Tenor互換）の場合
  if (Array.isArray(item.media) && item.media[0]) {
    const m = item.media[0];
    return m.gif?.url ?? m.tinygif?.url ?? m.mediumgif?.url ?? null;
  }
  return item.url ?? null;
}

async function getRandomGif() {
  const data = await klipyFetch('/gifs/trending?limit=50');
  const items = data.data ?? data.results ?? [];
  if (items.length === 0) throw new Error('GIFが取得できませんでした');
  const item = items[Math.floor(Math.random() * items.length)];
  return extractGifUrl(item);
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
  const data = await klipyFetch(`/gifs/search?q=${encodeURIComponent(categoryName)}&limit=50`);
  const items = data.data ?? data.results ?? [];
  if (items.length === 0) throw new Error('GIFが取得できませんでした');
  const item = items[Math.floor(Math.random() * items.length)];
  return extractGifUrl(item);
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
  ]
});

// ============================================================
// リアクション処理
// ============================================================
async function handleReaction(reaction, user, add) {
  if (user.bot) return;

  // 朝リマインドの出欠リアクション
  if (reaction.emoji.name === '✅') {
    const msgId = reaction.message.id;
    if (db.data.lastReminderMsgIds?.includes(msgId)) {
      const eventId = db.data.reminderMsgMap?.[msgId];
      if (!eventId) return;
      const guild  = reaction.message.guild;
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
    await calendar.events.delete({ calendarId: session.calendarId, eventId: targetEvent.id });
    delete db.data.pendingDeleteSessions[user.id];
    await db.write();
    await reaction.message.reply(`✅ 「${targetEvent.summary}」を削除しました`);
    console.log(`🗑️ 予定削除: "${targetEvent.summary}" by ${user.username}`);
  } catch (e) {
    await reaction.message.reply(`❌ 削除に失敗しました: ${e.message}`);
  }
}

client.on('messageReactionAdd',    (r, u) => handleReaction(r, u, true));
client.on('messageReactionRemove', (r, u) => handleReaction(r, u, false));

// ============================================================
// VC入室監視
// ============================================================
client.on('voiceStateUpdate', async (oldState, newState) => {
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
client.on('guildScheduledEventUpdate', async (oldEvent, newEvent) => {
  if (newEvent.guildId !== GUILD_ID) return;

  // ACTIVE（開始）
  if (newEvent.status === 2 && oldEvent.status !== 2) {
    console.log(`▶ イベント開始: "${newEvent.name}"`);
    await startVcSession(newEvent);
    return;
  }
  // 完了
  if (newEvent.status === 3 && oldEvent.status !== 3) {
    console.log(`⏹ イベント完了: "${newEvent.name}"`);
    await endVcSession(newEvent.id, newEvent.name);
    const guild = await client.guilds.fetch(GUILD_ID);
    await deleteEventRole(guild, newEvent.id, newEvent.name);
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
});

client.on('guildScheduledEventDelete', async event => {
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
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`   → morningTime = ${db.data.morningTime}`);
  console.log(`   → offsets     = ${db.data.reminderOffsets.join(',')}`);

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
  const gifCategoryChoices = safeCats
    .slice(0, 25)
    .map(c => ({ name: c.name ?? c.slug ?? String(c), value: c.slug ?? c.name ?? String(c) }))
    .filter(c => c.name && c.value);

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
  ].map(c => c.toJSON());

  await new REST({ version: '10' }).setToken(DISCORD_TOKEN)
    .put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
  console.log('✅ Slash commands registered');

  bootstrapSchedules();
});

// ============================================================
// コマンドハンドラ
// ============================================================
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  switch (interaction.commandName) {
    case 'ping': return interaction.reply('Pong!');

    case 'set-morning-time': {
      const time = interaction.options.getString('time');
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
      const guild  = await client.guilds.fetch(GUILD_ID);
      const events = await fetchWeekEvents(guild);
      if (events.size === 0) return interaction.reply('📭 今後1週間のイベントはありません');
      let msg = '📆 今後1週間のイベント一覧:\n';
      for (const e of events.values()) {
        const ts = new Date(e.scheduledStartTimestamp).toLocaleString('ja-JP', { weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });
        msg += `• ${e.name} / ${ts}\n`;
      }
      return interaction.reply(msg);
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
      const ch   = await client.channels.fetch(interaction.options.getChannel('channel').id);
      const text = interaction.options.getString('serial-number');
      try { await ch.send(text); return interaction.reply({ content: '✅ 接続設定を変更しました', flags: 64 }); }
      catch (e) { return interaction.reply({ content: `❌ 失敗: ${e.message}`, flags: 64 }); }
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
      const guild = await client.guilds.fetch(GUILD_ID);
      const names = [];
      for (const id of ids) {
        const m = await guild.members.fetch(id).catch(() => null);
        names.push(m ? `・${m.displayName} (${id})` : `・不明 (${id})`);
      }
      return interaction.reply(`📋 除外ユーザー一覧 (${ids.length}名):\n${names.join('\n')}`);
    }

    case 'exclude-user-export': {
      const buf = Buffer.from(JSON.stringify({ vcExcludeUsers: db.data.vcExcludeUsers ?? [] }, null, 2), 'utf-8');
      return interaction.reply({ content: '📤 エクスポートしました', files: [new AttachmentBuilder(buf, { name: 'exclude-users.json' })], flags: 64 });
    }

    case 'exclude-user-import': {
      const att = interaction.options.getAttachment('file');
      try {
        const json = await (await fetch(att.url)).json();
        if (!Array.isArray(json.vcExcludeUsers)) return interaction.reply({ content: '❌ 形式が正しくありません', flags: 64 });
        db.data.vcExcludeUsers = json.vcExcludeUsers;
        await db.write();
        return interaction.reply(`✅ インポートしました（${json.vcExcludeUsers.length}名）`);
      } catch (e) { return interaction.reply({ content: `❌ 失敗: ${e.message}`, flags: 64 }); }
    }

    case 'tm': {
      if (!calendarEnabled) return interaction.reply('⚠️ Calendar未設定');
      await interaction.deferReply();
      const month = interaction.options.getInteger('month');
      const day   = interaction.options.getInteger('day');
      const [h]   = interaction.options.getString('time').split(':').map(Number);
      const now   = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
      const target = { year: now.getFullYear(), month, day };
      const weekday = getWeekday(target.year, target.month, target.day);
      const label = `**${month}/${day}(${weekday}) ${h}:00**`;
      const results = await queryMemberCalendars(target, h);
      return interaction.editReply(formatCalendarResults(results, label));
    }

    case 'tm-week': {
      if (!calendarEnabled) return interaction.reply('⚠️ Calendar未設定');
      await interaction.deferReply();
      const [h] = interaction.options.getString('time').split(':').map(Number);
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
      let msg = '';
      for (let i = 0; i < 7; i++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
        const target = { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
        const weekday = getWeekday(target.year, target.month, target.day);
        const label = `**${target.month}/${target.day}(${weekday}) ${h}:00**`;
        const results = await queryMemberCalendars(target, h);
        msg += formatCalendarResults(results, label) + '\n\n';
      }
      return interaction.editReply(msg.trim());
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

      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
      const year = now.getFullYear();
      const [sh, sm] = startTime.split(':').map(Number);
      const [eh, em] = endTime.split(':').map(Number);

      const startDt = new Date(Date.UTC(year, month - 1, day, sh - 9, sm, 0));
      const endDt   = new Date(Date.UTC(year, month - 1, day, eh - 9, em, 0));

      try {
        await calendar.events.insert({
          calendarId: memberCfg.calendarId,
          resource: {
            summary: title,
            start: { dateTime: startDt.toISOString(), timeZone: 'Asia/Tokyo' },
            end:   { dateTime: endDt.toISOString(),   timeZone: 'Asia/Tokyo' },
          },
        });
        return interaction.reply(`✅ 「${title}」を ${month}/${day} ${startTime}〜${endTime} に追加しました`);
      } catch (e) { return interaction.reply({ content: `❌ 追加失敗: ${e.message}`, flags: 64 }); }
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
      const now      = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
      const year     = now.getFullYear();

      // 終日予定の終了日はGoogle Calendar的に「翌日」を指定
      const endDate = new Date(year, em - 1, ed + 1);
      const endDateStr = `${endDate.getFullYear()}-${String(endDate.getMonth()+1).padStart(2,'0')}-${String(endDate.getDate()).padStart(2,'0')}`;
      const startDateStr = `${year}-${String(sm).padStart(2,'0')}-${String(sd).padStart(2,'0')}`;

      try {
        await calendar.events.insert({
          calendarId: memberCfg.calendarId,
          resource: {
            summary: title,
            start: { date: startDateStr },
            end:   { date: endDateStr },
          },
        });
        return interaction.reply(`✅ 「${title}」を ${sm}/${sd}〜${em}/${ed} の終日予定として追加しました`);
      } catch (e) { return interaction.reply({ content: `❌ 追加失敗: ${e.message}`, flags: 64 }); }
    }

    case 'cal-delete': {
      if (!calendarEnabled) return interaction.reply('⚠️ Calendar未設定');
      const memberCfg = MEMBER_CONFIG[interaction.user.id];
      if (!memberCfg) return interaction.reply({ content: '⚠️ カレンダーが設定されていません', flags: 64 });

      const weeks  = interaction.options.getInteger('weeks');
      const now    = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
      const future = new Date(now.getTime() + weeks * 7 * 24 * 60 * 60 * 1000);

      await interaction.deferReply({ flags: 64 });

      try {
        const res = await calendar.events.list({
          calendarId: memberCfg.calendarId,
          timeMin: now.toISOString(),
          timeMax: future.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 19,
        });
        const events = res.data.items ?? [];
        if (events.length === 0) return interaction.editReply('📭 予定がありません');

        const numberEmojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟',
                              '1️⃣1️⃣','1️⃣2️⃣','1️⃣3️⃣','1️⃣4️⃣','1️⃣5️⃣','1️⃣6️⃣','1️⃣7️⃣','1️⃣8️⃣','1️⃣9️⃣'];

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
        msg += '\n数字リアクションで削除する予定を選択してください。❌でキャンセル。';

        const sent = await interaction.editReply({ content: msg });
        const sentMsg = await interaction.fetchReply();

        // リアクションを付ける
        await sentMsg.react('❌');
        for (let i = 0; i < Math.min(events.length, 10); i++) {
          await sentMsg.react(numberEmojis[i]);
        }

        // セッションを保存
        db.data.pendingDeleteSessions[interaction.user.id] = {
          msgId: sentMsg.id,
          requesterId: interaction.user.id,
          events: events.map(ev => ({ id: ev.id, summary: ev.summary })),
          calendarId: memberCfg.calendarId,
        };
        await db.write();
      } catch (e) { return interaction.editReply(`❌ 取得失敗: ${e.message}`); }
      break;
    }
  }
});

// ============================================================
// Bot ログイン
// ============================================================
client.login(DISCORD_TOKEN);
