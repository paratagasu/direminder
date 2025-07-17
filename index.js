import { serve } from '@hono/node-server';
import healthCheckServer from './server.js';
import { startHealthCheckCron } from './cron.js';
import { Client, IntentsBitField, REST, Routes, SlashCommandBuilder, Partials } from 'discord.js';
import * as nodeCron from 'node-cron';

const job = nodeCron.schedule('*/1 * * * *', () => {
  console.log('✅ 1分ごとのテストジョブが発火しました');
});
job.start();

import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import * as dotenv from 'dotenv';
dotenv.config();

// === ジョブ管理用のMap
const cronJobs = new Map();

// === ジョブ登録関数 ===
function registerCron(expr, fn, name) {
  // 現在時刻を表示（JSTで）
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  console.log(`🕒 現在時刻（JST）: ${now}`);
  console.log(`📌 登録予定のジョブ: ${name} → cron式: ${expr}`);

  // 古いジョブがあれば停止して削除
  if (cronJobs.has(name)) {
    const oldJob = cronJobs.get(name);
    if (typeof oldJob.stop === 'function') oldJob.stop();
    cronJobs.delete(name);
  }

  // 新しいジョブを登録
  const job = nodeCron.schedule(expr, fn, { scheduled: true });

  // 明示的にスタート（startが存在する場合のみ）
  if (typeof job.start === 'function') {
    job.start();
  } else {
    console.warn(`⚠️ job.start() が存在しません: ${name}`);
  }

  // ジョブ構造の確認ログ
  console.log(`🧪 job type for ${name}:`, typeof job);
  console.log(`🧪 job keys for ${name}:`, Object.keys(job));
  console.log(`🧪 job has start:`, typeof job.start === 'function');
  console.log(`🧪 job has cronTime:`, !!job.cronTime);

  // Mapに保存
  cronJobs.set(name, job);

  // 登録完了ログ
  console.log(`✅ ジョブ登録完了: ${name}`);
}

function unregisterCron(name) {
  if (cronJobs.has(name)) {
    cronJobs.get(name).stop();
    cronJobs.delete(name);
    console.log(`🧹 ジョブ削除: ${name}`);
  }
}

function getAllJobNames() {
  return Array.from(cronJobs.keys());
}

const { DISCORD_TOKEN, GUILD_ID, ANNOUNCE_CHANNEL_ID } = process.env;
if (!DISCORD_TOKEN || !GUILD_ID || !ANNOUNCE_CHANNEL_ID) {
  console.error('⚠️ .env に DISCORD_TOKEN, GUILD_ID, ANNOUNCE_CHANNEL_ID を設定してください');
  process.exit(1);
}

const defaultData = {
  morningTime: '07:00',
  firstOffset: 60,      // ← 必須
  secondOffset: 15,     // ← 必須
  enableStartRemind: true,
  monitorDelay: 5
};

const adapter = new JSONFile('settings.json');
const db = new Low(adapter, defaultData);
await db.read();
db.data ||= defaultData;
await db.write();

const ATTENDANCE_ROLE_NAME = '出席予定者';
let jobs = [];
let lastReminderMessageId = null;
let reminderDate = null;

function legacyregisterCron(expr, jobFn, desc) {
  console.log(`📌 登録予定: ${expr} (${desc})`);
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    console.warn(`❌ フィールド数が5ではありません: ${expr} (${desc})`);
    return;
  }

  const cronFieldRegex = /^(\*|\d+|\d+\/\d+|\d+\-\d+|\d+(,\d+)+)$/;
  const valid = parts.every(p => p === '*' || cronFieldRegex.test(p));
  if (!valid) {
    console.warn(`❌ 無効な cron 式フィールド検出: ${expr} (${desc})`);
    return;
  }

  const job = nodeCron.schedule(expr, jobFn, { timezone: 'Asia/Tokyo' });
  jobs.push(job);
}

function clearAllJobs() {
  jobs.forEach(j => j.stop());
  jobs.length = 0;
}

async function getOrCreateAttendanceRole(guild) {
  let role = guild.roles.cache.find(r => r.name === ATTENDANCE_ROLE_NAME);
  if (!role) {
    role = await guild.roles.create({
      name: ATTENDANCE_ROLE_NAME,
      color: '#F4C2C2',
      reason: '毎朝リマインドにより自動生成'
    });
    console.log('🎨 出席予定者ロールを作成しました');
  }
  return role;
}

async function clearAttendanceRole(role) {
  const members = role.members;
  for (const member of members.values()) {
    await member.roles.remove(role);
  }
  console.log('🚫 出席予定者ロールを全員から解除しました');
}

async function fetchTodaysEvents(guild) {
  const all = await guild.scheduledEvents.fetch();
  const todayJST = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
  return all.filter(e => {
    const ts = e.scheduledStartTimestamp;
    if (!ts || isNaN(new Date(ts).getTime())) return false;
    const eventDateJST = new Date(ts).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
    return eventDateJST === todayJST;
  });
}

async function sendMorningSummary(force = false) {
  console.log(`📅 sendMorningSummary() 実行開始（force=${force}）`);
  const guild = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(ANNOUNCE_CHANNEL_ID);
  const events = await fetchTodaysEvents(guild);
  const role = await getOrCreateAttendanceRole(guild);
  await clearAttendanceRole(role);

  if (events.size === 0) {
    await channel.send('📭 本日のイベントはありません。');
    console.log(`📭 イベントなし通知送信完了`);
    return;
  }

  let msg = `${force ? '' : '@everyone\n'}**📅 本日のイベント一覧**:\n`;
  for (const e of events.values()) {
    const time = new Date(e.scheduledStartTimestamp).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const host = e.creator?.username || '不明';
    const chanUrl = `https://discord.com/channels/${GUILD_ID}/${e.channelId}`;
    const eventUrl = `https://discord.com/events/${GUILD_ID}/${e.id}`;
    msg += `• ${e.name} / ${time} / ${host}\n` +
           `  📍 チャンネル: <${chanUrl}>\n` +
           `  🔗 イベント:   <${eventUrl}>\n`;
  }

  const reminder = await channel.send({
    content: msg + '\n✅ 出席／❌ 欠席 で参加表明お願いします！',
    allowedMentions: { parse: ['everyone'] } // ← @everyone の通知を有効化！
  });
  console.log(`✅ イベント一覧通知送信完了 (${reminder.id})`);

  await reminder.react('✅');
  await reminder.react('❌');
  console.log(`✅ リアクション追加完了`);

  lastReminderMessageId = reminder.id;
  reminderDate = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
}
function scheduleDailyReminders() {
  const [h, m] = (db.data.morningTime || defaultData.morningTime).split(':').map(Number);
  const morningExpr = `0 ${m} ${h} * * *`; // ✅ 分→時の順で正しい

  console.log(`📌 朝リマインド式: ${morningExpr}`); // ← ここに追加！

  registerCron(morningExpr, async () => {
    console.log(`🚀 朝リマインド実行: ${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`);
    try {
      await sendMorningSummary(false);
      console.log(`✅ 朝リマインド送信完了`);
    } catch (err) {
      console.error(`❌ 朝リマインド送信失敗: ${err.message}`);
    }
  }, '朝のまとめ');

// イベント再スケジュール
  registerCron('* * * * *', scheduleEventReminders, 'イベントの再スケジュール'); // 毎時0分など
}

async function scheduleEventReminders() {
  console.log('🧾 現在のジョブ一覧:', getAllJobNames());
  clearEventReminderJobs();
  const guild = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(ANNOUNCE_CHANNEL_ID);
  const events = await fetchTodaysEvents(guild);
  const role = await getOrCreateAttendanceRole(guild);

  const offsets = [
    db.data.firstOffset,
    db.data.secondOffset,
    ...(db.data.enableStartRemind ? [0] : [])
  ];

  for (const offset of offsets) {
    for (const e of events.values()) {
      const ts = e.scheduledStartTimestamp;
      if (!ts || isNaN(new Date(ts).getTime())) continue;

      const startJST = new Date(new Date(ts).toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
      const target = new Date(startJST.getTime() - offset * 60000);
      if (isNaN(target.getTime())) continue;

      const min = target.getMinutes();
      const hour = target.getHours();
      const day = target.getDate();
      const mon = target.getMonth() + 1;
      if ([min, hour, day, mon].some(n => isNaN(n))) continue;

      const expr = `${min} ${hour} ${day} ${mon} *`;
      const mention = `<@&${role.id}>`;
      const chanUrl = `https://discord.com/channels/${GUILD_ID}/${e.channelId}`;
      const eventUrl = `https://discord.com/events/${GUILD_ID}/${e.id}`;
      const timing = offset === 0 ? '開始' : `${offset}分前`;

      console.log(`📌 リマインド登録予定: offset=${offset} → ${expr} (${e.name})`);
      const jobName = `event '${e.name}' -${offset}m (${e.id})`;

      registerCron(expr, async () => {
        await channel.send(
          `${mention}\n⏰ **${timing}リマインド**「${e.name}」\n📍 <${chanUrl}>\n🔗 <${eventUrl}>`
        );
      }, jobName);

    }
  }

  // ✅ イベント開始後、未参加者チェック予約
  for (const e of events.values()) {
    scheduleNonAttendanceCheck(e);
  }
}

function scheduleNonAttendanceCheck(event) {
  const ts = event.scheduledStartTimestamp;
  if (!ts || isNaN(ts)) {
    console.warn(`⚠️ [${event.name}] 開始時刻が不正なため未参加チェックスキップ`);
    return;
  }

  const delayMs = (db.data.monitorDelay || 5) * 60000;
  const startJST = new Date(new Date(ts).toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const checkTime = new Date(startJST.getTime() + delayMs);

  const min = checkTime.getMinutes();
  const hour = checkTime.getHours();
  const day = checkTime.getDate();
  const mon = checkTime.getMonth() + 1;

  const expr = `${min} ${hour} ${day} ${mon} *`;
  console.log(`📌 未参加チェック登録: ${expr} (${event.name})`);

  registerCron(expr, async () => {
    console.log(`🚀 未参加チェック実行: ${event.name} at ${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`);
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      console.log(`✅ guild取得成功`);

      // ❌ 削除：await guild.members.fetch();
      // ✅ 代わりにロールメンバーを直接取得（キャッシュベース）

      const role = await getOrCreateAttendanceRole(guild);
      const roleMembers = Array.from(role.members.values());
      console.log(`✅ ロール取得成功: ${role.name} (${role.id}) → メンバー数: ${roleMembers.length}`);

      const channel = await guild.channels.fetch(event.channelId);
      console.log(`✅ チャンネル取得成功: ${channel.name} (${channel.id})`);

      const voiceTypes = [2, 13];
      if (!channel || !voiceTypes.includes(channel.type)) {
        console.warn(`⚠️ [${event.name}] VCではないため未参加チェックスキップ`);
        return;
      }

      const voiceMembers = Array.from(channel.members.keys());
      const missingIds = roleMembers.map(m => m.id).filter(id => !voiceMembers.includes(id));

      console.log(`🕵️ チェック結果: VC=${voiceMembers.length}, ロール=${roleMembers.length}, 未参加=${missingIds.length}`);

      if (missingIds.length > 0) {
        const mentionList = missingIds.map(id => `<@${id}>`).join('\n');
        await channel.send({
          content: `📢 以下の出席予定者がボイスチャンネルに未参加です:\n${mentionList}`,
          allowedMentions: { users: missingIds }
        });
        console.log(`✅ 未参加メンション通知送信完了`);
      } else {
        console.log(`✅ 全員参加済み。通知不要 (${event.name})`);
      }
    } catch (err) {
　　  console.error(`❌ 未参加チェックエラー: ${err.message}`);
    }

  }, `event '${event.name}' 参加未確認`);
}

function clearEventReminderJobs() {
  for (const jobName of getAllJobNames()) {
    if (jobName.startsWith("event ")) {
      unregisterCron(jobName);
      console.log(`🧹 ジョブ削除: ${jobName}`);
    }
  }
}

function bootstrapSchedules() {
  clearAllJobs();
  scheduleDailyReminders();
  scheduleEventReminders();
}
const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.GuildMessageReactions,
    IntentsBitField.Flags.GuildScheduledEvents
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.User]
});

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`   → morningTime = ${db.data.morningTime}`);
  console.log(`   → 1st offset  = ${db.data.firstOffset}`);
  console.log(`   → 2nd offset  = ${db.data.secondOffset}`);
  console.log(`🧪 cron.schedule source:\n`, nodeCron.schedule.toString().slice(0, 500));
  console.log(`🧪 nodeCron.schedule source:\n`, nodeCron.schedule.toString());


  const commands = [
    new SlashCommandBuilder().setName('ping').setDescription('Bot疎通チェック'),
    new SlashCommandBuilder().setName('set-morning-time').setDescription('朝リマインドの時刻を設定')
      .addStringOption(opt => opt.setName('time').setDescription('HH:MM形式').setRequired(true)),
    new SlashCommandBuilder().setName('set-first-reminder').setDescription('1回目のイベントリマインドを設定')
      .addIntegerOption(opt => opt.setName('minutes').setDescription('何分前').setRequired(true)),
    new SlashCommandBuilder().setName('set-second-reminder').setDescription('2回目のイベントリマインドを設定')
      .addIntegerOption(opt => opt.setName('minutes').setDescription('何分前').setRequired(true)),
    new SlashCommandBuilder().setName('week-events').setDescription('直近1週間のイベント一覧を表示'),
    new SlashCommandBuilder().setName('force-remind').setDescription('朝リマインドを即時発動する'),
    new SlashCommandBuilder().setName('toggle-start-remind').setDescription('イベント開始時の通知をオン／オフ切り替える'),
    new SlashCommandBuilder().setName('set-monitor-delay').setDescription('イベント監視遅延（分）を設定')
    .addIntegerOption(opt => opt.setName('minutes').setDescription('開始後何分で接続確認').setRequired(true))
  ].map(cmd => cmd.toJSON());

  await new REST({ version: '10' })
    .setToken(DISCORD_TOKEN)
    .put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });

  console.log('✅ Slash commands registered');
  bootstrapSchedules();

  for (const [name, job] of cronJobs.entries()) {
  const expr = job.cronTime?.source ?? 'N/A';
  console.log(`🧪 ジョブ: ${name}, running=${job.running ?? 'unknown'}, expr=${expr}`);
}

});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;

  console.log(`🧪 reactionAdd: emoji=${reaction.emoji.name}, messageId=${reaction.message?.id}, user=${user.username}, partial=${reaction.partial}`);

  try {
    if (reaction.partial) {
      await reaction.fetch();
      console.log(`🧪 reaction fetched: emoji=${reaction.emoji.name}, messageId=${reaction.message.id}`);
    }

    if (reaction.message.id !== lastReminderMessageId) return;
    if (reaction.emoji.name !== '✅') return;

    const guild = reaction.message.guild;
    const member = await guild.members.fetch(user.id);
    const role = await getOrCreateAttendanceRole(guild);

    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role);
      console.log(`➕ ロール付与: ${user.username}`);
    }
  } catch (err) {
    console.error(`❌ リアクション付与処理失敗: ${err.message}`);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  switch (interaction.commandName) {
    case 'ping':
  return interaction.reply('🏓 Pong!');

    case 'set-morning-time': {
      const time = interaction.options.getString('time');
      db.data.morningTime = time;
      await db.write();

      bootstrapSchedules(); // ✅ ジョブ再登録

      // ✅ 即時実行判定
      const now = new Date();
      const [h, m] = time.split(':').map(Number);
      const morning = new Date();
      morning.setHours(h, m, 0, 0);

      if (now >= morning) {
        console.log(`🕒 現在時刻 ${now.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' })} は朝リマインド後 → 強制実行`);
        await sendMorningSummary(true);
      } else {
        console.log(`🕒 現在時刻 ${now.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' })} は朝リマインド前 → cronに任せる`);
      }

      return interaction.reply(`✅ 朝リマインドを **${time}** に設定しました`);
    }

    case 'set-monitor-delay': {
  const minutes = interaction.options.getInteger('minutes');
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) {
    return interaction.reply({
      content: '❌ 有効な分数（1〜180）を指定してください',
      ephemeral: true
    });
  }

  db.data.monitorDelay = minutes;
  await db.write();
  bootstrapSchedules();

  return interaction.reply(`✅ 監視遅延を **${minutes}分** に設定しました`);
}

    case 'set-first-reminder': {
      const min = interaction.options.getInteger('minutes');
      db.data.firstOffset = min;
      await db.write();
      bootstrapSchedules();
      return interaction.reply(`✅ 1回目リマインドを **${min}分前** に設定しました`);
    }

    case 'set-second-reminder': {
      const min = interaction.options.getInteger('minutes');
      db.data.secondOffset = min;
      await db.write();
      bootstrapSchedules();
      return interaction.reply(`✅ 2回目リマインドを **${min}分前** に設定しました`);
    }

    case 'week-events': {
      await interaction.deferReply();
      const guild = await client.guilds.fetch(GUILD_ID);
      const events = await guild.scheduledEvents.fetch();
      const todayJST = new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" });
      const todayDate = new Date(todayJST);
      const weekLater = new Date(todayDate.getTime() + 7 * 86400000);

      const filtered = events.filter(e => {
        const start = new Date(new Date(e.scheduledStartTimestamp).toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
        return start >= todayDate && start <= weekLater;
      });

      if (filtered.size === 0)
        return interaction.editReply('📭 今後1週間のイベントはありません');

      let msg = '📆 今後1週間のイベント一覧:\n';
      for (const e of filtered.values()) {
        const ts = new Date(e.scheduledStartTimestamp).toLocaleString('ja-JP', {
          timeZone: 'Asia/Tokyo',
          weekday: 'short', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
        });
        const host = e.creator?.username || '不明';
        const chanUrl = `https://discord.com/channels/${GUILD_ID}/${e.channelId}`;
        const eventUrl = `https://discord.com/events/${GUILD_ID}/${e.id}`;
        msg += `• ${e.name} / ${ts} / ${host}\n` +
               `  📍 チャンネル: <${chanUrl}>\n` +
               `  🔗 イベント:   <${eventUrl}>\n`;
      }
      return interaction.editReply(msg);
    }

    case 'force-remind': {
      await interaction.deferReply();
      try {
        await sendMorningSummary(true);
        await interaction.editReply('✅ 朝リマインドを強制発動しました');
      } catch (e) {
        console.error(e);
        if (interaction.replied) {
          await interaction.followUp('❌ 実行エラーが発生しました');
        } else {
          await interaction.editReply('❌ 実行エラーが発生しました');
        }
      }
      break;
    }

    case 'toggle-start-remind': {
      db.data.enableStartRemind = !db.data.enableStartRemind;
      await db.write();
      bootstrapSchedules();
      return interaction.reply(
        `🕒 開始時通知を ${db.data.enableStartRemind ? '**有効化**' : '**無効化**'} しました`
      );
    }
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;

  console.log(`🧪 reactionRemove: emoji=${reaction.emoji.name}, messageId=${reaction.message?.id}, user=${user.username}, partial=${reaction.partial}`);

  try {
    if (reaction.partial) {
      await reaction.fetch(); // ✅ メッセージ情報を補完
      console.log(`🧪 reaction fetched: emoji=${reaction.emoji.name}, messageId=${reaction.message.id}`);
    }

    if (reaction.message.id !== lastReminderMessageId) return;
    if (reaction.emoji.name !== '✅') return;

    const guild = reaction.message.guild;
    const member = await guild.members.fetch(user.id);
    const role = await getOrCreateAttendanceRole(guild);

    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role);
      console.log(`➖ ロール解除: ${user.username}`);
    }
  } catch (err) {
    console.error(`❌ リアクション解除処理失敗: ${err.message}`);
  }
});

client.login(DISCORD_TOKEN);
serve({ fetch: healthCheckServer.fetch, port: 3000 });
startHealthCheckCron();