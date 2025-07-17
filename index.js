// index.js

import { serve } from '@hono/node-server';
import healthCheckServer from './server.js';
import { startHealthCheckCron } from './cron.js';
import {
  Client,
  IntentsBitField,
  REST,
  Routes,
  SlashCommandBuilder
} from 'discord.js';
import cron from 'node-cron';
import { Low, JSONFile } from 'lowdb';
import * as dotenv from 'dotenv';
dotenv.config();

// 環境変数チェック & ポート設定
const { DISCORD_TOKEN, GUILD_ID, ANNOUNCE_CHANNEL_ID } = process.env;
const PORT = process.env.PORT ?? 3000;
if (!DISCORD_TOKEN || !GUILD_ID || !ANNOUNCE_CHANNEL_ID) {
  console.error(
    '⚠️ .env に DISCORD_TOKEN, GUILD_ID, ANNOUNCE_CHANNEL_ID を設定してください'
  );
  process.exit(1);
}

// デフォルト設定
const defaultData = {
  morningTime: '07:00',         // 朝リマインドの時刻
  firstOffset: 60,              // １回目リマインド（分前）
  secondOffset: 15,             // ２回目リマインド（分前）
  startAnnouncement: true,      // イベント開始時の @everyone 通知
  absenceThreshold: 3           // 開始後◯分で不参加チェック
};

// DB 初期化
const adapter = new JSONFile('settings.json');
const db = new Low(adapter);
await db.read();
db.data = db.data
  ? { ...defaultData, ...db.data }
  : defaultData;
await db.write();

// cron ジョブ管理
const jobs = [];
function registerCron(expr, jobFn, desc) {
  console.log(`⏰ Register cron [${expr}] for ${desc}`);
  const job = cron.schedule(
    expr,
    async () => {
      console.log(
        `▶ Trigger cron [${expr}] for ${desc} at ${new Date().toLocaleString('ja-JP')}`
      );
      try {
        await jobFn();
      } catch (e) {
        console.error(`❌ Job error (${desc}):`, e);
      }
    },
    { timezone: 'Asia/Tokyo' }
  );
  jobs.push(job);
}
function clearAllJobs() {
  jobs.forEach((j) => j.stop());
  jobs.length = 0;
}

// イベント取得
async function fetchTodaysEvents(guild) {
  const all = await guild.scheduledEvents.fetch();
  const todayJST = new Date().toLocaleDateString('ja-JP', {
    timeZone: 'Asia/Tokyo'
  });

  return all.filter((e) => {
    const eventDateJST = new Date(e.scheduledStartTimestamp).toLocaleDateString('ja-JP', {
      timeZone: 'Asia/Tokyo'
    });
    return eventDateJST === todayJST;
  });
}

async function fetchWeekEvents(guild) {
  const all = await guild.scheduledEvents.fetch();
  const today = new Date();
  const todayJST = new Date(today.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const weekLater = new Date(todayJST);
  weekLater.setDate(todayJST.getDate() + 7);

  return all.filter((e) => {
    const eventDate = new Date(
      new Date(e.scheduledStartTimestamp).toLocaleString('en-US', {
        timeZone: 'Asia/Tokyo'
      })
    );
    return eventDate >= todayJST && eventDate <= weekLater;
  });
}

// リマインドロジック
// 先頭に追加しておいてください
let lastMorningMessage = null;

async function sendMorningSummary(isForced = false) {
  const guild   = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(ANNOUNCE_CHANNEL_ID);

   // 「出席予定者」ロール取得 or 作成
   let role = guild.roles.cache.find(r => r.name === '出席予定者');
   if (!role) {
     role = await guild.roles.create({
       name: '出席予定者',
       color: '#FFC0CB',  // Pink の HEX コード
       reason: '自動作成: 出席予定者ロール'
     });
   }

  // 2) 毎朝リマインド実行時は既存の「出席予定者」ロールを全員から剥奪
  const members = await guild.members.fetch();
  for (const member of members.values()) {
    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role).catch(console.error);
    }
  }

  // 3) 今日のイベント取得
  const events = await fetchTodaysEvents(guild);

  // 4) メッセージ本文組み立て
  let content = '';
  if (events.size === 0) {
    // イベントなし
    content = isForced
      ? '📭 本日のイベントはありません'
      : '@everyone\n📭 本日のイベントはありません';
  } else {
    // イベントあり
    content = isForced ? '' : '@everyone\n';
    content += '📅 本日のイベント一覧:\n';
    for (const e of events.values()) {
      const time = new Date(e.scheduledStartTimestamp)
        .toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' });
      const host     = e.creator?.username || '不明';
      const chanUrl  = `https://discord.com/channels/${GUILD_ID}/${e.channelId}`;
      const eventUrl = `https://discord.com/events/${GUILD_ID}/${e.id}`;
      content +=
        `• ${e.name} / ${time} / ${host}\n` +
        `  📍 チャンネル: <${chanUrl}>\n` +
        `  🔗 イベント:   <${eventUrl}>\n`;
    }
    content += '\n✅ 出席／❌ 欠席 で参加表明お願いします！';
  }

  // 5) メッセージ送信＆リアクション付与
  const msg = await channel.send({ content });
  lastMorningMessage = msg;
  if (events.size > 0) {
    await msg.react('✅');
    await msg.react('❌');
  }
}

async function scheduleEventReminders() {
  const guild   = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(ANNOUNCE_CHANNEL_ID);
  const events  = await fetchTodaysEvents(guild);

  // 「出席予定者」ロール取得 or 作成
  let role = guild.roles.cache.find(r => r.name === '出席予定者');
  if (!role) {
    role = await guild.roles.create({
      name: '出席予定者',
      color: '#FFC0CB',
      reason: '自動作成: 出席予定者ロール'
    });
  }

  for (const e of events.values()) {
    // JST でイベント開始時刻を取得
    const startJST = new Date(
      new Date(e.scheduledStartTimestamp)
        .toLocaleString('en-US', { timeZone: 'Asia/Tokyo' })
    );

    // １回目／２回目のリマインドを個別設定から取得
    const offsets = [db.data.firstOffset, db.data.secondOffset];
    for (const offset of offsets) {
      // リマインド時刻を逆算
      const target = new Date(startJST.getTime() - offset * 60000);
      // cron 式を JST で構成
      const expr = `${target.getMinutes()} ${target.getHours()} ${target.getDate()} ${target.getMonth() + 1} *`;

      registerCron(expr, async () => {
        try {
          await channel.send(
            `<@&${role.id}> ⏰ **${offset}分前リマインド** 「${e.name}」\n` +
            `📍 チャンネル: <https://discord.com/channels/${GUILD_ID}/${e.channelId}>\n` +
            `🔗 イベント:   <https://discord.com/events/${GUILD_ID}/${e.id}>`
          );
        } catch (err) {
          console.error(`❌ リマインド送信失敗 (${offset}分前): ${e.name}`, err);
        }
      }, `event '${e.name}' -${offset}m`);
    }

    // イベント開始時の @everyone 通知 (オン/オフ切り替え)
    if (db.data.startAnnouncement) {
      const expr0 = `${startJST.getMinutes()} ${startJST.getHours()} ${startJST.getDate()} ${startJST.getMonth() + 1} *`;
      registerCron(expr0, async () => {
        try {
          await channel.send(
            `@everyone\n🚀 「${e.name}」が始まりました！`
          );
        } catch (err) {
          console.error(`❌ 開始通知失敗: ${e.name}`, err);
        }
      }, `start-announcement '${e.name}'`);
    }

    // イベント開始後のボイス参加チェック
    const thresholdMs = (db.data.absenceThreshold || 3) * 60000;
    const checkTime  = new Date(startJST.getTime() + thresholdMs);
    const exprChk    = `${checkTime.getMinutes()} ${checkTime.getHours()} ${checkTime.getDate()} ${checkTime.getMonth() + 1} *`;

    registerCron(exprChk, async () => {
      try {
        const eChannel = await guild.channels.fetch(e.channelId);
        if (!eChannel.isVoiceBased()) return;

        // VC にいるメンバー ID
        const voiceIds = [...eChannel.members.keys()];
        // ロールを持っているのに VC にいないメンバー
        const absent = (await guild.members.fetch())
          .filter(m => m.roles.cache.has(role.id) && !voiceIds.includes(m.id))
          .map(m => `<@${m.id}>`);

        if (absent.length > 0) {
          await channel.send(
            `⚠️ 以下の出席予定者が参加していません:\n` +
            absent.join('\n')
          );
        }
      } catch (err) {
        console.error(`❌ 不在チェック失敗: ${e.name}`, err);
      }
    }, `absence-check '${e.name}' +${db.data.absenceThreshold}m`);
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
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildScheduledEvents,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.GuildVoiceStates,
    IntentsBitField.Flags.GuildMessageReactions
  ],
  partials: ['MESSAGE', 'CHANNEL', 'REACTION']
});


// リアルタイムイベント検知
client.on('guildScheduledEventCreate', async event => {
  if (event.guildId !== GUILD_ID) return;
  console.log(`🆕 New scheduled event detected: ${event.name}`);

  const guild   = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(ANNOUNCE_CHANNEL_ID);

  // 出席予定者ロール取得 or 作成
  let role = guild.roles.cache.find(r => r.name === '出席予定者');
  if (!role) {
    role = await guild.roles.create({
      name: '出席予定者',
      color: 'Pink',
      reason: '自動作成: 出席予定者ロール'
    });
  }

  // JSTでイベント開始時刻を取得
  const startJST = new Date(
    new Date(event.scheduledStartTimestamp)
      .toLocaleString('en-US', { timeZone: 'Asia/Tokyo' })
  );

  // １回目／２回目リマインド
  const offsets = [db.data.firstOffset, db.data.secondOffset];
  for (const offset of offsets) {
    const target = new Date(startJST.getTime() - offset * 60000);
    const expr = `${target.getMinutes()} ${target.getHours()} ${target.getDate()} ${target.getMonth() + 1} *`;

    registerCron(expr, async () => {
      try {
        const ch = await client.guilds
          .fetch(GUILD_ID)
          .then(g => g.channels.fetch(ANNOUNCE_CHANNEL_ID));
        await ch.send(
          `<@&${role.id}> ⏰ **${offset}分前リマインド** 「${event.name}」\n` +
          `📍 チャンネル: <https://discord.com/channels/${GUILD_ID}/${event.channelId}>\n` +
          `🔗 イベント:   <https://discord.com/events/${GUILD_ID}/${event.id}>`
        );
      } catch (err) {
        console.error(`❌ リマインド送信失敗 (${offset}分前): ${event.name}`, err);
      }
    }, `new-event '${event.name}' -${offset}m`);
  }

  // イベント開始時 @everyone 通知（オン/オフ判定）
  if (db.data.startAnnouncement) {
    const expr0 = `${startJST.getMinutes()} ${startJST.getHours()} ${startJST.getDate()} ${startJST.getMonth() + 1} *`;
    registerCron(expr0, async () => {
      try {
        const ch = await client.guilds
          .fetch(GUILD_ID)
          .then(g => g.channels.fetch(ANNOUNCE_CHANNEL_ID));
        await ch.send(
          `@everyone\n🚀 「${event.name}」が始まりました！`
        );
      } catch (err) {
        console.error(`❌ 開始通知失敗: ${event.name}`, err);
      }
    }, `new-event-start '${event.name}'`);
  }

  // 開始後のボイス不在チェック
  const thresholdMs = (db.data.absenceThreshold || 3) * 60000;
  const checkTime  = new Date(startJST.getTime() + thresholdMs);
  const exprChk    = `${checkTime.getMinutes()} ${checkTime.getHours()} ${checkTime.getDate()} ${checkTime.getMonth() + 1} *`;

  registerCron(exprChk, async () => {
    try {
      const guild2  = await client.guilds.fetch(GUILD_ID);
      const ch2     = await guild2.channels.fetch(ANNOUNCE_CHANNEL_ID);
      const eChannel = await guild2.channels.fetch(event.channelId);
      if (!eChannel.isVoiceBased()) return;

      const voiceIds = [...eChannel.members.keys()];
      const members = await guild2.members.fetch();
      const absent = members
        .filter(m => m.roles.cache.has(role.id) && !voiceIds.includes(m.id))
        .map(m => `<@${m.id}>`);

      if (absent.length > 0) {
        await ch2.send(
          `⚠️ 以下の出席予定者が参加していません:\n` +
          absent.join('\n')
        );
      }
    } catch (err) {
      console.error(`❌ 不在チェック失敗: ${event.name}`, err);
    }
  }, `new-event-absence '${event.name}' +${db.data.absenceThreshold}m`);
});

// スラッシュコマンド登録＆Bot起動
 client.once('ready', async () => {
   console.log(`✅ Logged in as ${client.user.tag}`);
   console.log(`   → morningTime       = ${db.data.morningTime}`);
   console.log(`   → firstOffset       = ${db.data.firstOffset}分前`);
   console.log(`   → secondOffset      = ${db.data.secondOffset}分前`);
   console.log(`   → startAnnouncement = ${db.data.startAnnouncement}`);
   console.log(`   → absenceThreshold  = ${db.data.absenceThreshold}分`);


  const commands = [
    new SlashCommandBuilder().setName('ping').setDescription('Bot疎通チェック'),
    new SlashCommandBuilder()
      .setName('set-morning-time')
      .setDescription('朝リマインドの時刻を設定')
      .addStringOption(opt => opt.setName('time').setDescription('HH:MM形式').setRequired(true)),

    new SlashCommandBuilder()
      .setName('set-first-offset')
      .setDescription('１回目リマインドを何分前にするか設定')
      .addIntegerOption(opt => opt.setName('minutes').setDescription('分数').setRequired(true)),

    new SlashCommandBuilder()
      .setName('set-second-offset')
      .setDescription('２回目リマインドを何分前にするか設定')
      .addIntegerOption(opt => opt.setName('minutes').setDescription('分数').setRequired(true)),

    new SlashCommandBuilder()
      .setName('toggle-start-announcement')
      .setDescription('イベント開始時の @everyone 通知をオン/オフ')
      .addBooleanOption(opt => opt.setName('enabled').setDescription('true=オン, false=オフ').setRequired(true)),

    new SlashCommandBuilder()
      .setName('force-morning')
      .setDescription('朝のリマインドを強制実行'),

    new SlashCommandBuilder()
      .setName('set-absence-threshold')
      .setDescription('参加チェックの遅延時間(分)を設定')
      .addIntegerOption(opt => opt.setName('minutes').setDescription('分数').setRequired(true)),

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

    case 'set-first-offset': {
      const min = interaction.options.getInteger('minutes');
      db.data.firstOffset = min;
      await db.write();
      bootstrapSchedules();
      return interaction.reply(`✅ １回目リマインドを**${min}分前**に設定しました`);
    }

    case 'set-second-offset': {
      const min = interaction.options.getInteger('minutes');
      db.data.secondOffset = min;
       await db.write();
      bootstrapSchedules();
      return interaction.reply(`✅ ２回目リマインドを**${min}分前**に設定しました`);
    }

    case 'toggle-start-announcement': {
       const enabled = interaction.options.getBoolean('enabled');
       db.data.startAnnouncement = enabled;
       await db.write();
      bootstrapSchedules();
       return interaction.reply(`✅ イベント開始時の @everyone 通知を**${enabled ? 'オン' : 'オフ'}**に設定し、即時反映しました`);
    }

    case 'force-morning': {
      await sendMorningSummary(true);
      return interaction.reply('✅ 強制的に朝リマインドを実行しました');
    }

    case 'set-absence-threshold': {
      const min = interaction.options.getInteger('minutes');
      db.data.absenceThreshold = min;
      await db.write();
      bootstrapSchedules();
      return interaction.reply(`✅ 不参加チェックを開始${min}分後に設定しました`);
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

// メッセージリアクションのハンドラ
client.on('messageReactionAdd', async (reaction, user) => {
  console.log('✅ ReactionAdd received:', reaction.emoji.name, 'by', user.username);

  if (reaction.message.partial) await reaction.message.fetch();
  if (reaction.message.id !== lastMorningMessage?.id) return;
  if (user.bot) return;

  const guild = await client.guilds.fetch(GUILD_ID);
  const member = await guild.members.fetch(user.id);
  const role = guild.roles.cache.find(r => r.name === '出席予定者');
  if (reaction.emoji.name === '✅') {
    await member.roles.add(role).catch(console.error);
  }
  if (reaction.emoji.name === '❌') {
    await member.roles.remove(role).catch(console.error);
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (reaction.message.partial) await reaction.message.fetch(); // ← ここ！

  if (reaction.message.id !== lastMorningMessage?.id) return;
  if (user.bot) return;

  const guild = await client.guilds.fetch(GUILD_ID);
  const member = await guild.members.fetch(user.id);
  const role = guild.roles.cache.find(r => r.name === '出席予定者');
  if (reaction.emoji.name === '✅') {
    await member.roles.remove(role).catch(console.error);
  }
  // ❌ の除去は無視してOK
});

// Discord Bot ログイン
client.login(DISCORD_TOKEN);

//Koyeb用のヘルスチェックサーバーを起動
serve({
  fetch: healthCheckServer.fetch,
  port: 3000
});
startHealthCheckCron();