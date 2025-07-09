// index.js

import {serve} from '@hono/node-server';
import healthCheckServer from './server';
import {startHealthCheckCron} from './cron';
import { Client, IntentsBitField, REST, Routes, SlashCommandBuilder } from 'discord.js';
import express from 'express';
import cron from 'node-cron';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import * as dotenv from 'dotenv';
dotenv.config();

// 環境変数チェック
const { DISCORD_TOKEN, GUILD_ID, ANNOUNCE_CHANNEL_ID, PORT } = process.env;
if (!DISCORD_TOKEN || !GUILD_ID || !ANNOUNCE_CHANNEL_ID) {
  console.error('⚠️ .env に DISCORD_TOKEN, GUILD_ID, ANNOUNCE_CHANNEL_ID を設定してください');
  process.exit(1);
}

// Express アプリ（スリープ防止用）
const app = express();
app.get('/', (req, res) => res.send('Bot is alive!'));
const port = PORT || 3000;
app.listen(port, () => console.log(`🌐 Web server running on port ${port}`));

// デフォルト設定
const defaultData = {
  morningTime: '07:00',
  reminderOffsets: [60, 15]
};

// DB 初期化
const adapter = new JSONFile('settings.json');
const db = new Low(adapter, defaultData);
await db.read();
db.data ||= defaultData;
await db.write();

// cron ジョブ管理
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

// イベント取得
async function fetchTodaysEvents(guild) {
  const all = await guild.scheduledEvents.fetch();

  const todayJST = new Date().toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo"
  });

  return all.filter(e => {
    const eventDateJST = new Date(e.scheduledStartTimestamp).toLocaleDateString("ja-JP", {
      timeZone: "Asia/Tokyo"
    });
    return eventDateJST === todayJST;
  });
}
async function fetchWeekEvents(guild) {
  const all = await guild.scheduledEvents.fetch();

  const today = new Date();
  const todayJST = new Date(today.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const weekLaterJST = new Date(todayJST);
  weekLaterJST.setDate(todayJST.getDate() + 7);

  return all.filter(e => {
    const eventDateJST = new Date(new Date(e.scheduledStartTimestamp).toLocaleString("en-US", {
      timeZone: "Asia/Tokyo"
    }));
    return eventDateJST >= todayJST && eventDateJST <= weekLaterJST;
  });
}

// リマインドロジック
async function sendMorningSummary() {
  const guild   = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(ANNOUNCE_CHANNEL_ID);
  const events  = await fetchTodaysEvents(guild);
  if (events.size === 0) {
    console.log('📭 本日のイベントはありません');
    return;
  }

  let msg = '📅 本日のイベント一覧:\n';
  for (const e of events.values()) {
    const time = new Date(e.scheduledStartTimestamp).toLocaleTimeString('ja-JP', {
  timeZone: 'Asia/Tokyo'
});
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

  for (const offset of db.data.reminderOffsets) {
    for (const e of events.values()) {
      // JSTでイベント開始時刻を取得
      const startJST = new Date(new Date(e.scheduledStartTimestamp).toLocaleString("en-US", {
        timeZone: "Asia/Tokyo"
      }));

      // JSTでリマインド時刻を逆算
      const target = new Date(startJST.getTime() - offset * 60000);

      // cron式をJSTで構成
      const expr = `${target.getMinutes()} ${target.getHours()} ${target.getDate()} ${target.getMonth() + 1} *`;

      const chanUrl  = `https://discord.com/channels/${GUILD_ID}/${e.channelId}`;
      const eventUrl = `https://discord.com/events/${GUILD_ID}/${e.id}`;

      registerCron(expr, async () => {
        try {
          await channel.send(
            `⏰ **${offset}分前リマインド** 「${e.name}」\n` +
            `📍 チャンネル: <${chanUrl}>\n` +
            `🔗 イベント:   <${eventUrl}>`
          );
        } catch (err) {
          console.error(`❌ リマインド送信失敗: ${e.name}`, err);
        }
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

// Discord Client（スケジュール作成前に定義）
const client = new Client({
  intents: [IntentsBitField.Flags.Guilds, IntentsBitField.Flags.GuildScheduledEvents]
});

// リアルタイムイベント検知
client.on('guildScheduledEventCreate', async event => {
  if (event.guildId !== GUILD_ID) return;
  console.log(`🆕 New scheduled event detected: ${event.name}`);
  for (const offset of db.data.reminderOffsets) {
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

// スラッシュコマンド登録＆Bot起動
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`   → morningTime = ${db.data.morningTime}`);
  console.log(`   → offsets     = ${db.data.reminderOffsets.join(',')}`);

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
      .setDescription('直近1週間のイベント一覧を表示')
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

// コマンドハンドラ
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
      await interaction.deferReply(); // ← 追加！

      const guild  = await client.guilds.fetch(GUILD_ID);
      const events = await fetchWeekEvents(guild);

      if (events.size === 0) {
        return interaction.editReply('📭 今後1週間のイベントはありません'); // ← reply → editReply に変更！
      }

      let msg = '📆 今後1週間のイベント一覧:\n';
      for (const e of events.values()) {
        const ts = new Date(e.scheduledStartTimestamp).toLocaleString('ja-JP', {
          timeZone: 'Asia/Tokyo',
          weekday: 'short', year: 'numeric',
          month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit'
        });
        const host = e.creator?.username || '不明';
        const chanUrl = `https://discord.com/channels/${GUILD_ID}/${e.channelId}`;
        const eventUrl = `https://discord.com/events/${GUILD_ID}/${e.id}`;
        msg += `• ${e.name} / ${ts} / ${host}\n` +
               `  📍 チャンネル: <${chanUrl}>\n` +
               `  🔗 イベント:   <${eventUrl}>\n`;
      }

      return interaction.editReply(msg); // ← ここも editReply に変更！
    }
  }
});

// Discord Bot ログイン
client.login(DISCORD_TOKEN);

//Koyeb用のヘルスチェックサーバーを起動
serve({
  fetch: healthCheckServer.fetch,
  port: 3000
});
startHealthCheckCron();