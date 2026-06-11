// index.js

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import cron from 'node-cron';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { google } from 'googleapis';
import { Client, IntentsBitField, REST, Routes, SlashCommandBuilder } from 'discord.js';
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
  console.log('ℹ️ GOOGLE_SERVICE_ACCOUNT_KEY / GOOGLE_CALENDAR_ID が未設定のため Calendar 連携をスキップ');
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

// ヘルスチェック cron（10分ごと）
const HEALTH_CHECK_URL = process.env.HEALTH_CHECK_URL || `http://localhost:${PORT}`;
cron.schedule('*/10 * * * *', async () => {
  const now = new Date().toLocaleString('ja-JP');
  console.log(`🔍 [${now}] ヘルスチェック実行中... (${HEALTH_CHECK_URL})`);
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
  eventMap: {}
};

const adapter = new JSONFile('settings.json');
const db = new Low(adapter, defaultData);
await db.read();
db.data ||= defaultData;
db.data.eventMap ??= {};
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
    const res = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      resource: toCalendarEvent(discordEvent),
    });
    db.data.eventMap[discordEvent.id] = res.data.id;
    await db.write();
    console.log(`📅 Google Calendar に追加: "${discordEvent.name}"`);
  } catch (e) {
    console.error(`❌ Google Calendar 作成失敗 ("${discordEvent.name}"):`, e.message);
  }
}

async function updateCalendarEvent(discordEvent) {
  if (!calendarEnabled) return;
  const gcalId = db.data.eventMap[discordEvent.id];
  if (!gcalId) { await createCalendarEvent(discordEvent); return; }
  try {
    await calendar.events.patch({
      calendarId: GOOGLE_CALENDAR_ID,
      eventId: gcalId,
      resource: toCalendarEvent(discordEvent),
    });
    console.log(`🔄 Google Calendar を更新: "${discordEvent.name}"`);
  } catch (e) {
    if (e.code === 404) {
      delete db.data.eventMap[discordEvent.id];
      await db.write();
      await createCalendarEvent(discordEvent);
    } else {
      console.error(`❌ Google Calendar 更新失敗 ("${discordEvent.name}"):`, e.message);
    }
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
    if (e.code === 410 || e.code === 404) {
      delete db.data.eventMap[discordEventId];
      await db.write();
    } else {
      console.error(`❌ Google Calendar 削除失敗 ("${name}"):`, e.message);
    }
  }
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
  const today = new Date().toISOString().slice(0, 10);
  return all.filter(e => new Date(e.scheduledStartTimestamp).toISOString().startsWith(today));
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
// リマインドロジック
// ============================================================
async function sendMorningSummary() {
  const guild   = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(ANNOUNCE_CHANNEL_ID);
  const events  = await fetchTodaysEvents(guild);
  if (events.size === 0) { console.log('📭 本日のイベントはありません'); return; }

  let msg = '📅 本日のイベント一覧:\n';
  for (const e of events.values()) {
    const time     = new Date(e.scheduledStartTimestamp).toLocaleTimeString('ja-JP');
    const host     = e.creator?.username || '不明';
    const chanUrl  = `https://discord.com/channels/${GUILD_ID}/${e.channelId}`;
    const eventUrl = `https://discord.com/events/${GUILD_ID}/${e.id}`;
    msg += `• ${e.name} / ${time} / ${host}\n` +
           `  📍 チャンネル: <${chanUrl}>\n` +
           `  🔗 イベント:   <${eventUrl}>\n`;
  }
  const reminder = await channel.send({ content: msg + '\n✅ 出席／❌ 欠席 で参加表明お願いします！' });
  await reminder.react('✅');
  await reminder.react('❌');
}

async function scheduleEventReminders() {
  const guild   = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(ANNOUNCE_CHANNEL_ID);
  const events  = await fetchTodaysEvents(guild);

  for (const offset of (db.data.reminderOffsets ?? defaultData.reminderOffsets)) {
    for (const e of events.values()) {
      const target   = new Date(e.scheduledStartTimestamp - offset * 60000);
      const expr     = `${target.getMinutes()} ${target.getHours()} ${target.getDate()} ${target.getMonth() + 1} *`;
      const chanUrl  = `https://discord.com/channels/${GUILD_ID}/${e.channelId}`;
      const eventUrl = `https://discord.com/events/${GUILD_ID}/${e.id}`;
      registerCron(expr, async () => {
        await channel.send(
          `⏰ **${offset}分前リマインド** 「${e.name}」\n` +
          `📍 チャンネル: <${chanUrl}>\n` +
          `🔗 イベント:   <${eventUrl}>`
        );
      }, `event '${e.name}' -${offset}m`);
    }
  }
}

function scheduleDailyReminders() {
  const [h, m] = (db.data.morningTime || defaultData.morningTime).split(':');
  registerCron(`0 ${m} ${h} * * *`, sendMorningSummary, 'morning summary');
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
    IntentsBitField.Flags.GuildScheduledEvents,
  ]
});

// ============================================================
// リアルタイムイベント検知
// ============================================================
client.on('guildScheduledEventCreate', async event => {
  if (event.guildId !== GUILD_ID) return;
  console.log(`🆕 New scheduled event: "${event.name}"`);
  await createCalendarEvent(event);

  for (const offset of (db.data.reminderOffsets ?? defaultData.reminderOffsets)) {
    const target   = new Date(event.scheduledStartTimestamp - offset * 60000);
    const expr     = `${target.getMinutes()} ${target.getHours()} ${target.getDate()} ${target.getMonth() + 1} *`;
    const chanUrl  = `https://discord.com/channels/${GUILD_ID}/${event.channelId}`;
    const eventUrl = `https://discord.com/events/${GUILD_ID}/${event.id}`;
    registerCron(expr, async () => {
      const ch = await client.guilds.fetch(GUILD_ID).then(g => g.channels.fetch(ANNOUNCE_CHANNEL_ID));
      await ch.send(
        `⏰ **${offset}分前リマインド** 「${event.name}」\n` +
        `📍 チャンネル: <${chanUrl}>\n` +
        `🔗 イベント:   <${eventUrl}>`
      );
    }, `new-event '${event.name}' -${offset}m`);
  }
});

client.on('guildScheduledEventUpdate', async (oldEvent, newEvent) => {
  if (newEvent.guildId !== GUILD_ID) return;
  console.log(`✏️ Updated scheduled event: "${newEvent.name}"`);
  if (newEvent.status === 4) {
    await deleteCalendarEvent(newEvent.id, newEvent.name);
    return;
  }
  await updateCalendarEvent(newEvent);
});

client.on('guildScheduledEventDelete', async event => {
  if (event.guildId !== GUILD_ID) return;
  console.log(`🗑️ Deleted scheduled event: "${event.name}"`);
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
      .setName('set-reminder-offset')
      .setDescription('イベントリマインドの分前を設定')
      .addIntegerOption(opt => opt.setName('minutes').setDescription('何分前').setRequired(true)),
    new SlashCommandBuilder()
      .setName('week-events')
      .setDescription('直近1週間のイベント一覧を表示'),
    new SlashCommandBuilder()
      .setName('sync-calendar')
      .setDescription('今後のDiscordイベントをGoogleカレンダーに一括同期する'),
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

    case 'set-reminder-offset': {
      const min = interaction.options.getInteger('minutes');
      db.data.reminderOffsets = [min];
      await db.write();
      bootstrapSchedules();
      return interaction.reply(`✅ リマインドを **${min}分前** に設定し再登録しました`);
    }

    case 'week-events': {
      const guild  = await client.guilds.fetch(GUILD_ID);
      const events = await fetchWeekEvents(guild);
      if (events.size === 0) return interaction.reply('📭 今後1週間のイベントはありません');

      let msg = '📆 今後1週間のイベント一覧:\n';
      for (const e of events.values()) {
        const ts = new Date(e.scheduledStartTimestamp).toLocaleString('ja-JP', {
          weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit'
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
  }
});

// ============================================================
// Discord Bot ログイン
// ============================================================
client.login(DISCORD_TOKEN);
