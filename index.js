import { serve } from '@hono/node-server';
import healthCheckServer from './server.js';
import { startHealthCheckCron } from './cron.js';
import { Client, IntentsBitField, REST, Routes, SlashCommandBuilder, Partials } from 'discord.js';
import cron from 'node-cron';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import * as dotenv from 'dotenv';
dotenv.config();

const { DISCORD_TOKEN, GUILD_ID, ANNOUNCE_CHANNEL_ID } = process.env;
if (!DISCORD_TOKEN || !GUILD_ID || !ANNOUNCE_CHANNEL_ID) {
  console.error('⚠️ .env に DISCORD_TOKEN, GUILD_ID, ANNOUNCE_CHANNEL_ID を設定してください');
  process.exit(1);
}

const defaultData = {
  morningTime: '07:00',
  firstOffset: 60,
  secondOffset: 15,
 enableStartRemind: true
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

function registerCron(expr, jobFn, desc) {
  const parts = expr.split(' ');
  if (parts.some(p => isNaN(parseInt(p)))) {
    console.warn(`❌ 無効な cron 式: ${expr} (${desc})`);
    return;
  }
  const job = cron.schedule(expr, jobFn, { timezone: 'Asia/Tokyo' });
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
  const guild = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(ANNOUNCE_CHANNEL_ID);
  const events = await fetchTodaysEvents(guild);
  const role = await getOrCreateAttendanceRole(guild);
  await clearAttendanceRole(role);

  if (events.size === 0) {
    await channel.send('📭 本日のイベントはありません。');
    return;
  }

  let msg = `${force ? '' : '@everyone'}\n**📅 本日のイベント一覧**:\n`;
  for (const e of events.values()) {
    const time = new Date(e.scheduledStartTimestamp).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const host = e.creator?.username || '不明';
    const chanUrl = `https://discord.com/channels/${GUILD_ID}/${e.channelId}`;
    const eventUrl = `https://discord.com/events/${GUILD_ID}/${e.id}`;
    msg += `• ${e.name} / ${time} / ${host}\n` +
           `  📍 チャンネル: <${chanUrl}>\n` +
           `  🔗 イベント:   <${eventUrl}>\n`;
  }  

  const reminder = await channel.send(msg + '\n✅ 出席／❌ 欠席 で参加表明お願いします！');
  await reminder.react('✅');
  await reminder.react('❌');

  lastReminderMessageId = reminder.id;
  reminderDate = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
}
function scheduleDailyReminders() {
  const [h, m] = (db.data.morningTime || defaultData.morningTime).split(':').map(v => parseInt(v));
  const morningExpr = `0 ${m} ${h} * * *`; // ← 数値として構築

  registerCron(morningExpr, () => sendMorningSummary(false), '朝のまとめ');
  registerCron('0 0 * * *', scheduleEventReminders, 'イベントの再スケジュール');
}

async function scheduleEventReminders() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(ANNOUNCE_CHANNEL_ID);
  const events = await fetchTodaysEvents(guild);
  const role = await getOrCreateAttendanceRole(guild);

  // 通知対象オフセットを条件で構築（開始時通知のON/OFF制御）
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

      registerCron(expr, async () => {
        await channel.send(
          `${mention}\n⏰ **${timing}リマインド**「${e.name}」\n📍 <${chanUrl}>\n🔗 <${eventUrl}>`
        );
      }, `event '${e.name}' -${offset}m`);
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
    new SlashCommandBuilder().setName('toggle-start-remind').setDescription('イベント開始時の通知をオン／オフ切り替える')
  ].map(cmd => cmd.toJSON());

  await new REST({ version: '10' })
    .setToken(DISCORD_TOKEN)
    .put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });

  console.log('✅ Slash commands registered');
  bootstrapSchedules();
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
      bootstrapSchedules();
      return interaction.reply(`✅ 朝リマインドを **${time}** に設定しました`);
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
        await interaction.editReply('❌ 実行エラーが発生しました');
        console.error(e);
      }
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

client.on('messageReactionAdd', async (reaction, user) => {
  if (reaction.partial) await reaction.fetch();
  if (user.bot || !reaction.message.guildId) return;

  const messageDate = new Date(reaction.message.createdAt).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
  if (reaction.message.id !== lastReminderMessageId || messageDate !== reminderDate) return;
  if (reaction.emoji.name !== '✅') return;

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const role = await getOrCreateAttendanceRole(guild);
    const member = await guild.members.fetch(user.id);
    await member.roles.add(role);
    console.log(`🎟 ${user.username} に出席予定者ロールを付与しました`);
  } catch (e) {
    console.error(`❌ ロール付与失敗: ${user.username}`, e);
  }
});

client.login(DISCORD_TOKEN);
serve({ fetch: healthCheckServer.fetch, port: 3000 });
startHealthCheckCron();