// index.js

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import cron from 'node-cron';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { google } from 'googleapis';
import { Client, IntentsBitField, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import * as dotenv from 'dotenv';
dotenv.config();

// ============================================================
// 環境変数チェック
// ============================================================
const {
  DISCORD_TOKEN, GUILD_ID, ANNOUNCE_CHANNEL_ID,
  GOOGLE_SERVICE_ACCOUNT_KEY,
  GOOGLE_CALENDAR_ID,
} = process.env;
const PORT = process.env.PORT ?? 3000;

if (!DISCORD_TOKEN || !GUILD_ID || !ANNOUNCE_CHANNEL_ID) {
  console.error('⚠️ .env に DISCORD_TOKEN, GUILD_ID, ANNOUNCE_CHANNEL_ID を設定してください');
  process.exit(1);
}

// ============================================================
// Google Calendar 初期化
// ============================================================
let calendarEnabled = false;
let calendar = null;

if (GOOGLE_SERVICE_ACCOUNT_KEY && GOOGLE_CALENDAR_ID) {
  try {
    const serviceAccountKey = JSON.parse(GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccountKey,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    calendar = google.calendar({ version: 'v3', auth });
    calendarEnabled = true;
    console.log('✅ Google Calendar 連携が有効になりました');
  } catch (e) {
    console.error('⚠️ Google Calendar 初期化失敗（連携なしで起動します）:', e.message);
  }
} else {
  console.log('ℹ️ Google Calendar 連携をスキップ');
}

// ============================================================
// Hono サーバー（ヘルスチェック用）
// ============================================================
const app = new Hono();
app.get('/', (c) => c.json({
  status: 'ok',
  message: 'Discord Bot is running',
  node_version: process.version,
  timestamp: new Date().toISOString(),
}));
serve({ fetch: app.fetch, port: PORT });
console.log(`🌐 Web server running on port ${PORT}`);

const HEALTH_CHECK_URL = process.env.HEALTH_CHECK_URL || `http://localhost:${PORT}`;
cron.schedule('*/10 * * * *', async () => {
  const now = new Date().toLocaleString('ja-JP');
  try {
    const res = await fetch(HEALTH_CHECK_URL);
    if (res.ok) console.log(`✅ [${now}] ヘルスチェック成功: ${res.status}`);
    else console.warn(`⚠️ [${now}] ヘルスチェック失敗: ${res.status}`);
  } catch (err) {
    console.error(`❌ [${now}] ヘルスチェックエラー:`, err);
  }
}, { timezone: 'Asia/Tokyo' });

// ============================================================
// DB 初期化
// ============================================================
const defaultData = {
  morningTime: '07:00',
  reminderOffsets: [60, 15],
  eventMap: {},       // Discord Event ID → Google Calendar Event ID
  eventRoles: {},     // Discord Event ID → Discord Role ID
  reminderMsgMap: {}, // メッセージID → Discord Event ID（最新リマインドのみ有効）
  lastReminderMsgIds: [], // 最新の朝リマインドメッセージIDリスト
  vcParticipants: {}, // Discord Event ID → 参加者IDセット
};

const adapter = new JSONFile('settings.json');
const db = new Low(adapter, defaultData);
await db.read();
db.data ||= defaultData;
db.data.eventMap        ??= {};
db.data.eventRoles      ??= {};
db.data.reminderMsgMap  ??= {};
db.data.lastReminderMsgIds ??= [];
db.data.vcParticipants  ??= {};
// null も考慮してリセット
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
  };
}

async function createCalendarEvent(discordEvent) {
  if (!calendarEnabled) return;
  try {
    const res = await calendar.events.insert({ calendarId: GOOGLE_CALENDAR_ID, resource: toCalendarEvent(discordEvent) });
    db.data.eventMap[discordEvent.id] = res.data.id;
    await db.write();
    console.log(`📅 Google Calendar に追加: "${discordEvent.name}"`);
  } catch (e) { console.error(`❌ Google Calendar 作成失敗:`, e.message); }
}

async function updateCalendarEvent(discordEvent) {
  if (!calendarEnabled) return;
  const gcalId = db.data.eventMap[discordEvent.id];
  if (!gcalId) { await createCalendarEvent(discordEvent); return; }
  try {
    await calendar.events.patch({ calendarId: GOOGLE_CALENDAR_ID, eventId: gcalId, resource: toCalendarEvent(discordEvent) });
    console.log(`🔄 Google Calendar を更新: "${discordEvent.name}"`);
  } catch (e) {
    if (e.code === 404) { delete db.data.eventMap[discordEvent.id]; await db.write(); await createCalendarEvent(discordEvent); }
    else console.error(`❌ Google Calendar 更新失敗:`, e.message);
  }
}

async function deleteCalendarEvent(discordEventId, name = '不明') {
  if (!calendarEnabled) return;
  const gcalId = db.data.eventMap[discordEventId];
  if (!gcalId) return;
  try {
    await calendar.events.delete({ calendarId: GOOGLE_CALENDAR_ID, eventId: gcalId });
    delete db.data.eventMap[discordEventId];
    await db.write();
    console.log(`🗑️ Google Calendar から削除: "${name}"`);
  } catch (e) {
    if (e.code === 410 || e.code === 404) { delete db.data.eventMap[discordEventId]; await db.write(); }
    else console.error(`❌ Google Calendar 削除失敗:`, e.message);
  }
}

// ============================================================
// イベント終了時に参加者をGoogleカレンダーに書き込む
// ============================================================
async function writeParticipantsToCalendar(discordEvent) {
  if (!calendarEnabled) return;
  const gcalId = db.data.eventMap[discordEvent.id];
  if (!gcalId) return;

  const participantIds = db.data.vcParticipants[discordEvent.id] ?? [];
  if (participantIds.length === 0) {
    console.log(`📝 参加者なし: "${discordEvent.name}"`);
    return;
  }

  try {
    // メンバー名を取得
    const guild = await client.guilds.fetch(GUILD_ID);
    const names = [];
    for (const userId of participantIds) {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member) names.push(member.displayName);
    }

    // 既存のイベント説明を取得して参加者を追記
    const existing = await calendar.events.get({ calendarId: GOOGLE_CALENDAR_ID, eventId: gcalId });
    const oldDesc = existing.data.description || '';
    const newDesc = oldDesc + `\n\n🎙️ 参加者 (${names.length}名):\n` + names.map(n => `・${n}`).join('\n');

    await calendar.events.patch({
      calendarId: GOOGLE_CALENDAR_ID,
      eventId: gcalId,
      resource: { description: newDesc },
    });
    console.log(`📝 参加者をCalendarに書き込み: "${discordEvent.name}" (${names.length}名)`);
  } catch (e) {
    console.error(`❌ 参加者書き込み失敗:`, e.message);
  }
}

// ============================================================
// イベントごとのロール管理
// ============================================================

/** イベント用ロールを取得または作成する */
async function getOrCreateEventRole(guild, event) {
  const existingRoleId = db.data.eventRoles[event.id];
  if (existingRoleId) {
    const role = guild.roles.cache.get(existingRoleId) || await guild.roles.fetch(existingRoleId).catch(() => null);
    if (role) return role;
  }
  // ロールを新規作成
  const role = await guild.roles.create({
    name: `参加予定_${event.name}`,
    color: 0x57F287,
    reason: `Discordイベント「${event.name}」の参加予定者管理用`,
  });
  db.data.eventRoles[event.id] = role.id;
  await db.write();
  console.log(`🎭 ロール作成: "${role.name}"`);
  return role;
}

/** イベント用ロールを削除する */
async function deleteEventRole(guild, eventId, eventName = '不明') {
  const roleId = db.data.eventRoles[eventId];
  if (!roleId) return;
  try {
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (role) await role.delete(`イベント「${eventName}」終了のため`);
    delete db.data.eventRoles[eventId];
    await db.write();
    console.log(`🗑️ ロール削除: 参加予定_${eventName}`);
  } catch (e) {
    console.error(`❌ ロール削除失敗:`, e.message);
    delete db.data.eventRoles[eventId];
    await db.write();
  }
}

/** 全ての参加予定ロールをメンバーから剥奪（ロール自体は残す） */
async function stripAllEventRoles(guild) {
  for (const [eventId, roleId] of Object.entries(db.data.eventRoles)) {
    try {
      const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
      if (!role) continue;
      const members = role.members;
      for (const member of members.values()) {
        await member.roles.remove(role).catch(() => {});
      }
    } catch (e) {
      console.error(`❌ ロール剥奪失敗 (${roleId}):`, e.message);
    }
  }
  console.log('🧹 全参加予定ロールを剥奪しました');
}

// ============================================================
// cron ジョブ管理
// ============================================================
const jobs = [];
function registerCron(expr, jobFn, desc) {
  console.log(`⏰ Register cron [${expr}] for ${desc}`);
  const job = cron.schedule(expr, async () => {
    console.log(`▶ Trigger cron [${expr}] for ${desc} at ${new Date().toLocaleString('ja-JP')}`);
    try { await jobFn(); }
    catch (e) { console.error(`❌ Job error (${desc}):`, e); }
  }, { timezone: 'Asia/Tokyo' });
  jobs.push(job);
}
function clearAllJobs() {
  jobs.forEach(j => j.stop());
  jobs.length = 0;
}

// ============================================================
// イベント取得
// ============================================================
async function fetchTodaysEvents(guild) {
  const all = await guild.scheduledEvents.fetch();
  const todayJST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const todayStr = `${todayJST.getFullYear()}-${String(todayJST.getMonth()+1).padStart(2,'0')}-${String(todayJST.getDate()).padStart(2,'0')}`;
  return all.filter(e => {
    const d = new Date(new Date(e.scheduledStartTimestamp).toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const s = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    return s === todayStr;
  });
}

async function fetchWeekEvents(guild) {
  const now = new Date();
  const weekLater = new Date(now);
  weekLater.setDate(now.getDate() + 7);
  const all = await guild.scheduledEvents.fetch();
  return all.filter(e => {
    const s = new Date(e.scheduledStartTimestamp);
    return s >= now && s <= weekLater;
  });
}

// ============================================================
// 朝リマインド送信
// ============================================================
async function sendMorningSummary(withEveryone = true) {
  const guild   = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(ANNOUNCE_CHANNEL_ID);
  const events  = await fetchTodaysEvents(guild);

  // 前日の参加予定ロールを全員から剥奪
  await stripAllEventRoles(guild);

  const mention = withEveryone ? '@everyone\n' : '';

  if (events.size === 0) {
    await channel.send({ content: `${mention}📭 本日のイベントはありません`, allowedMentions: { parse: withEveryone ? ['everyone'] : [] } });
    console.log('📭 本日のイベントはありません');
    return;
  }

  // イベントごとに個別メッセージを送信
  const newMsgIds = [];
  const newMsgMap = {};

  // まず全体アナウンス（@everyoneあり）
  await channel.send({
    content: `${mention}📅 本日のイベント一覧 (${events.size}件)`,
    allowedMentions: { parse: withEveryone ? ['everyone'] : [] }
  });

  for (const e of events.values()) {
    const role     = await getOrCreateEventRole(guild, e);
    const time     = new Date(e.scheduledStartTimestamp).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const host     = e.creator?.username || '不明';
    const chanUrl  = `https://discord.com/channels/${GUILD_ID}/${e.channelId}`;
    const eventUrl = `https://discord.com/events/${GUILD_ID}/${e.id}`;

    const msg = `## ◆${e.name}\n` +
                `${time} / ${host}\n` +
                `📍 チャンネル: <${chanUrl}>\n` +
                `🔗 イベント:   <${eventUrl}>\n` +
                `✅ 出席／❌ 欠席 で参加表明お願いします！`;

    const sent = await channel.send({
      content: msg,
      allowedMentions: { roles: [role.id] }
    });
    await sent.react('✅');
    await sent.react('❌');

    newMsgIds.push(sent.id);
    newMsgMap[sent.id] = e.id;
  }

  // 最新リマインドのメッセージID群を保存
  db.data.lastReminderMsgIds = newMsgIds;
  db.data.reminderMsgMap = newMsgMap;
  await db.write();
}

// ============================================================
// イベントリマインドcron登録
// ============================================================
async function scheduleEventReminders() {
  const guild  = await client.guilds.fetch(GUILD_ID);
  const events = await fetchTodaysEvents(guild);

  for (const offset of (db.data.reminderOffsets ?? defaultData.reminderOffsets)) {
    for (const e of events.values()) {
      const target = new Date(e.scheduledStartTimestamp - offset * 60000);
      const jst    = new Date(target.getTime() + 9 * 60 * 60 * 1000);
      const expr   = `${jst.getUTCMinutes()} ${jst.getUTCHours()} ${jst.getUTCDate()} ${jst.getUTCMonth() + 1} *`;
      const chanUrl  = `https://discord.com/channels/${GUILD_ID}/${e.channelId}`;
      const eventUrl = `https://discord.com/events/${GUILD_ID}/${e.id}`;

      registerCron(expr, async () => {
        const g    = await client.guilds.fetch(GUILD_ID);
        const ch   = await g.channels.fetch(ANNOUNCE_CHANNEL_ID);
        const role = await getOrCreateEventRole(g, e);
        await ch.send({
          content: `${role}\n⏰ **${offset}分前リマインド** 「${e.name}」\n` +
                   `📍 チャンネル: <${chanUrl}>\n` +
                   `🔗 イベント:   <${eventUrl}>`,
          allowedMentions: { roles: [role.id] }
        });
      }, `event '${e.name}' -${offset}m`);
    }
  }

  // イベント開始時アナウンス
  for (const e of events.values()) {
    const start = new Date(e.scheduledStartTimestamp);
    const jst   = new Date(start.getTime() + 9 * 60 * 60 * 1000);
    const expr  = `${jst.getUTCMinutes()} ${jst.getUTCHours()} ${jst.getUTCDate()} ${jst.getUTCMonth() + 1} *`;
    const chanUrl  = `https://discord.com/channels/${GUILD_ID}/${e.channelId}`;
    const eventUrl = `https://discord.com/events/${GUILD_ID}/${e.id}`;

    registerCron(expr, async () => {
      const g    = await client.guilds.fetch(GUILD_ID);
      const ch   = await g.channels.fetch(ANNOUNCE_CHANNEL_ID);
      const role = await getOrCreateEventRole(g, e);
      await ch.send({
        content: `@everyone\n🚀 **「${e.name}」が始まりました！**\n` +
                 `📍 会場チャンネル: <${chanUrl}>\n` +
                 `🔗 イベントリンク: <${eventUrl}>`,
        allowedMentions: { parse: ['everyone'] }
      });
    }, `start-announcement '${e.name}'`);

    // 開始3分後の未参加チェック
    const check = new Date(e.scheduledStartTimestamp + 3 * 60000);
    const jstC  = new Date(check.getTime() + 9 * 60 * 60 * 1000);
    const exprC = `${jstC.getUTCMinutes()} ${jstC.getUTCHours()} ${jstC.getUTCDate()} ${jstC.getUTCMonth() + 1} *`;

    registerCron(exprC, async () => {
      const g    = await client.guilds.fetch(GUILD_ID);
      const ch   = await g.channels.fetch(ANNOUNCE_CHANNEL_ID);
      const role = await getOrCreateEventRole(g, e);

      // イベントのVCチャンネルを取得
      const vcChannel = e.channelId ? await g.channels.fetch(e.channelId).catch(() => null) : null;
      if (!vcChannel) return;

      // VCに参加していない参加予定者を抽出
      const vcMemberIds = new Set(vcChannel.members?.keys() ?? []);
      const absentees = role.members.filter(m => !vcMemberIds.has(m.id));

      if (absentees.size === 0) return;

      const mentions = absentees.map(m => `<@${m.id}>`).join('\n');
      await ch.send({
        content: `⚠️ 以下の出席予定者が参加していません:\n${mentions}`,
        allowedMentions: { users: [...absentees.keys()] }
      });
    }, `absence-check '${e.name}' +3m`);
  }
}

function scheduleDailyReminders() {
  const [h, m] = (db.data.morningTime || defaultData.morningTime).split(':');
  registerCron(`0 ${m} ${h} * * *`, () => sendMorningSummary(true), 'morning summary');
  registerCron('0 0 * * *', scheduleEventReminders, 'reschedule events');
}

function bootstrapSchedules() {
  clearAllJobs();
  scheduleDailyReminders();
  scheduleEventReminders();
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
// リアクションでロール付与/剥奪
// ============================================================
async function handleReaction(reaction, user, add) {
  if (user.bot) return;
  if (reaction.emoji.name !== '✅') return;

  const msgId = reaction.message.id;

  // 最新リマインドのメッセージのみ有効
  if (!db.data.lastReminderMsgIds?.includes(msgId)) return;

  // このメッセージに対応するイベントIDを取得
  const eventId = db.data.reminderMsgMap?.[msgId];
  if (!eventId) return;

  const guild  = reaction.message.guild;
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  const roleId = db.data.eventRoles[eventId];
  if (!roleId) return;
  const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
  if (!role) return;

  if (add) {
    await member.roles.add(role).catch(() => {});
    console.log(`✅ ${user.username} に ${role.name} を付与`);
  } else {
    await member.roles.remove(role).catch(() => {});
    console.log(`❌ ${user.username} から ${role.name} を剥奪`);
  }
}

client.on('messageReactionAdd',    (reaction, user) => handleReaction(reaction, user, true));
client.on('messageReactionRemove', (reaction, user) => handleReaction(reaction, user, false));

// ============================================================
// VCへの参加を記録（イベントのVCチャンネルへの入室のみ）
// ============================================================
client.on('voiceStateUpdate', async (oldState, newState) => {
  if (newState.guild.id !== GUILD_ID) return;
  const userId = newState.id;
  if (!newState.channelId || newState.channelId === oldState.channelId) return;

  // 今日のイベントのVCチャンネルと照合
  try {
    const guild = newState.guild;
    const all = await guild.scheduledEvents.fetch();
    for (const e of all.values()) {
      if (e.channelId === newState.channelId) {
        if (!db.data.vcParticipants[e.id]) db.data.vcParticipants[e.id] = [];
        const list = db.data.vcParticipants[e.id];
        if (!list.includes(userId)) {
          list.push(userId);
          await db.write();
          console.log(`🎙️ VC参加記録: ${userId} → イベント「${e.name}」`);
        }
      }
    }
  } catch (err) {
    console.error('voiceStateUpdate error:', err);
  }
});

// ============================================================
// リアルタイムイベント検知
// ============================================================
client.on('guildScheduledEventCreate', async event => {
  if (event.guildId !== GUILD_ID) return;
  console.log(`🆕 New scheduled event: "${event.name}"`);
  await createCalendarEvent(event);

  for (const offset of (db.data.reminderOffsets ?? defaultData.reminderOffsets)) {
    const target = new Date(event.scheduledStartTimestamp - offset * 60000);
    const jst    = new Date(target.getTime() + 9 * 60 * 60 * 1000);
    const expr   = `${jst.getUTCMinutes()} ${jst.getUTCHours()} ${jst.getUTCDate()} ${jst.getUTCMonth() + 1} *`;
    const chanUrl  = `https://discord.com/channels/${GUILD_ID}/${event.channelId}`;
    const eventUrl = `https://discord.com/events/${GUILD_ID}/${event.id}`;
    registerCron(expr, async () => {
      const g    = await client.guilds.fetch(GUILD_ID);
      const ch   = await g.channels.fetch(ANNOUNCE_CHANNEL_ID);
      const role = await getOrCreateEventRole(g, event);
      await ch.send({
        content: `${role}\n⏰ **${offset}分前リマインド** 「${event.name}」\n` +
                 `📍 チャンネル: <${chanUrl}>\n` +
                 `🔗 イベント:   <${eventUrl}>`,
        allowedMentions: { roles: [role.id] }
      });
    }, `new-event '${event.name}' -${offset}m`);
  }
});

client.on('guildScheduledEventUpdate', async (oldEvent, newEvent) => {
  if (newEvent.guildId !== GUILD_ID) return;

  // キャンセル
  if (newEvent.status === 4) {
    const guild = await client.guilds.fetch(GUILD_ID);
    await deleteEventRole(guild, newEvent.id, newEvent.name);
    await deleteCalendarEvent(newEvent.id, newEvent.name);
    delete db.data.vcParticipants[newEvent.id];
    await db.write();
    return;
  }

  // 完了（COMPLETED = 3）→ 参加者をGoogleカレンダーに書き込み
  if (newEvent.status === 3 && oldEvent.status !== 3) {
    await writeParticipantsToCalendar(newEvent);
    const guild = await client.guilds.fetch(GUILD_ID);
    await deleteEventRole(guild, newEvent.id, newEvent.name);
    delete db.data.vcParticipants[newEvent.id];
    await db.write();
    return;
  }

  await updateCalendarEvent(newEvent);
});

client.on('guildScheduledEventDelete', async event => {
  if (event.guildId !== GUILD_ID) return;
  const guild = await client.guilds.fetch(GUILD_ID);
  await deleteEventRole(guild, event.id, event.name);
  await deleteCalendarEvent(event.id, event.name);
});

// ============================================================
// スラッシュコマンド登録 & Bot起動
// ============================================================
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`   → morningTime     = ${db.data.morningTime}`);
  console.log(`   → offsets         = ${(db.data.reminderOffsets ?? []).join(',')}`);
  console.log(`   → calendarEnabled = ${calendarEnabled}`);

  const commands = [
    new SlashCommandBuilder().setName('ping').setDescription('Bot疎通チェック'),
    new SlashCommandBuilder()
      .setName('set-morning-time')
      .setDescription('朝リマインドの時刻を設定')
      .addStringOption(opt => opt.setName('time').setDescription('HH:MM形式').setRequired(true)),
    new SlashCommandBuilder()
      .setName('add-reminder-offset')
      .setDescription('リマインド時刻を追加（例: 60分前）')
      .addIntegerOption(opt => opt.setName('minutes').setDescription('何分前').setRequired(true)),
    new SlashCommandBuilder()
      .setName('remove-reminder-offset')
      .setDescription('リマインド時刻を削除')
      .addIntegerOption(opt => opt.setName('minutes').setDescription('何分前').setRequired(true)),
    new SlashCommandBuilder()
      .setName('list-reminder-offsets')
      .setDescription('現在のリマインド時刻一覧を表示'),
    new SlashCommandBuilder()
      .setName('week-events')
      .setDescription('直近1週間のイベント一覧を表示'),
    new SlashCommandBuilder()
      .setName('sync-calendar')
      .setDescription('今後のDiscordイベントをGoogleカレンダーに一括同期する'),
    new SlashCommandBuilder()
      .setName('force-remind')
      .setDescription('朝リマインドを今すぐ送信する（@everyoneあり）'),
    new SlashCommandBuilder()
      .setName('n-force-remind')
      .setDescription('朝リマインドを今すぐ送信する（@everyoneなし）'),
    new SlashCommandBuilder()
      .setName('send-message')
      .setDescription('指定チャンネルにメッセージを送信する（管理者専用）')
      .addChannelOption(opt => opt.setName('channel').setDescription('送信先チャンネル').setRequired(true))
      .addStringOption(opt => opt.setName('text').setDescription('送信するテキスト').setRequired(true)),
  ].map(cmd => cmd.toJSON());

  await new REST({ version: '10' }).setToken(DISCORD_TOKEN)
    .put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
  console.log('✅ Slash commands registered');

  bootstrapSchedules();

  cron.schedule('* * * * *', () => {
    console.log('🔄 Polling & re-bootstrapping schedules');
    bootstrapSchedules();
  }, { timezone: 'Asia/Tokyo' });
});

// ============================================================
// コマンドハンドラ
// ============================================================
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  switch (interaction.commandName) {
    case 'ping':
      return interaction.reply('Pong!');

    case 'set-morning-time': {
      const time = interaction.options.getString('time');
      db.data.morningTime = time;
      await db.write();
      bootstrapSchedules();
      return interaction.reply(`✅ 朝リマインドを **${time}** に設定し再登録しました`);
    }

    case 'add-reminder-offset': {
      const min = interaction.options.getInteger('minutes');
      db.data.reminderOffsets ??= [];
      if (!db.data.reminderOffsets.includes(min)) {
        db.data.reminderOffsets.push(min);
        db.data.reminderOffsets.sort((a, b) => b - a); // 降順ソート
        await db.write();
        bootstrapSchedules();
        return interaction.reply(`✅ **${min}分前** リマインドを追加しました（現在: ${db.data.reminderOffsets.join(', ')}分前）`);
      } else {
        return interaction.reply(`ℹ️ **${min}分前** はすでに設定されています（現在: ${db.data.reminderOffsets.join(', ')}分前）`);
      }
    }

    case 'remove-reminder-offset': {
      const min = interaction.options.getInteger('minutes');
      db.data.reminderOffsets ??= [];
      const idx = db.data.reminderOffsets.indexOf(min);
      if (idx !== -1) {
        db.data.reminderOffsets.splice(idx, 1);
        await db.write();
        bootstrapSchedules();
        return interaction.reply(`✅ **${min}分前** リマインドを削除しました（現在: ${db.data.reminderOffsets.join(', ')}分前）`);
      } else {
        return interaction.reply(`ℹ️ **${min}分前** は設定されていません（現在: ${db.data.reminderOffsets.join(', ')}分前）`);
      }
    }

    case 'list-reminder-offsets': {
      const offsets = db.data.reminderOffsets ?? [];
      if (offsets.length === 0) return interaction.reply('📭 リマインド時刻が設定されていません');
      return interaction.reply(`⏰ 現在のリマインド設定: **${offsets.join(', ')}分前**`);
    }

    case 'week-events': {
      const guild  = await client.guilds.fetch(GUILD_ID);
      const events = await fetchWeekEvents(guild);
      if (events.size === 0) return interaction.reply('📭 今後1週間のイベントはありません');
      let msg = '📆 今後1週間のイベント一覧:\n';
      for (const e of events.values()) {
        const ts = new Date(e.scheduledStartTimestamp).toLocaleString('ja-JP', {
          weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo'
        });
        const host     = e.creator?.username || '不明';
        const chanUrl  = `https://discord.com/channels/${GUILD_ID}/${e.channelId}`;
        const eventUrl = `https://discord.com/events/${GUILD_ID}/${e.id}`;
        msg += `• ${e.name} / ${ts} / ${host}\n` +
               `  📍 チャンネル: <${chanUrl}>\n` +
               `  🔗 イベント:   <${eventUrl}>\n`;
      }
      return interaction.reply(msg);
    }

    case 'sync-calendar': {
      if (!calendarEnabled) return interaction.reply('⚠️ Google Calendar 連携が設定されていません');
      await interaction.deferReply();
      const guild  = await client.guilds.fetch(GUILD_ID);
      const events = await fetchWeekEvents(guild);
      if (events.size === 0) return interaction.editReply('📭 同期するイベントがありません');
      let created = 0, updated = 0;
      for (const e of events.values()) {
        if (db.data.eventMap[e.id]) { await updateCalendarEvent(e); updated++; }
        else { await createCalendarEvent(e); created++; }
      }
      return interaction.editReply(`✅ Google Calendar 同期完了\n　新規登録: ${created}件 / 更新: ${updated}件`);
    }

    case 'force-remind': {
      await interaction.deferReply({ ephemeral: true });
      await sendMorningSummary(true);
      return interaction.editReply('✅ リマインドを送信しました（@everyoneあり）');
    }

    case 'n-force-remind': {
      await interaction.deferReply({ ephemeral: true });
      await sendMorningSummary(false);
      return interaction.editReply('✅ リマインドを送信しました（@everyoneなし）');
    }

    case 'send-message': {
      const member = interaction.member;
      const isAdmin = member?.permissions?.has?.('Administrator') ?? false;
      if (!isAdmin) return interaction.reply({ content: '⛔ このコマンドは管理者専用です', ephemeral: true });
      const targetChannel = interaction.options.getChannel('channel');
      const text = interaction.options.getString('text');
      try {
        const ch = await client.channels.fetch(targetChannel.id);
        await ch.send(text);
        return interaction.reply({ content: `✅ <#${targetChannel.id}> にメッセージを送信しました`, ephemeral: true });
      } catch (e) {
        return interaction.reply({ content: `❌ 送信に失敗しました: ${e.message}`, ephemeral: true });
      }
    }
  }
});

// ============================================================
// Discord Bot ログイン
// ============================================================
client.login(DISCORD_TOKEN);
