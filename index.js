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
// 迺ｰ蠅・､画焚繝√ぉ繝・け
// ============================================================
const {
  DISCORD_TOKEN, GUILD_ID, ANNOUNCE_CHANNEL_ID,
  GOOGLE_SERVICE_ACCOUNT_KEY,
  GOOGLE_CALENDAR_ID,
} = process.env;
const PORT = process.env.PORT ?? 3000;

if (!DISCORD_TOKEN || !GUILD_ID || !ANNOUNCE_CHANNEL_ID) {
  console.error('笞・・.env 縺ｫ DISCORD_TOKEN, GUILD_ID, ANNOUNCE_CHANNEL_ID 繧定ｨｭ螳壹＠縺ｦ縺上□縺輔＞');
  process.exit(1);
}

// ============================================================
// Google Calendar 蛻晄悄蛹・// ============================================================
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
    console.log('笨・Google Calendar 騾｣謳ｺ縺梧怏蜉ｹ縺ｫ縺ｪ繧翫∪縺励◆');
  } catch (e) {
    console.error('笞・・Google Calendar 蛻晄悄蛹門､ｱ謨暦ｼ磯｣謳ｺ縺ｪ縺励〒襍ｷ蜍輔＠縺ｾ縺呻ｼ・', e.message);
  }
} else {
  console.log('邃ｹ・・GOOGLE_SERVICE_ACCOUNT_KEY / GOOGLE_CALENDAR_ID 縺梧悴險ｭ螳壹・縺溘ａ Calendar 騾｣謳ｺ繧偵せ繧ｭ繝・・');
}

// ============================================================
// Hono 繧ｵ繝ｼ繝舌・・医・繝ｫ繧ｹ繝√ぉ繝・け逕ｨ・・// ============================================================
const app = new Hono();
app.get('/', (c) => c.json({
  status: 'ok',
  message: 'Discord Bot is running',
  node_version: process.version,
  timestamp: new Date().toISOString(),
}));
serve({ fetch: app.fetch, port: PORT });
console.log(`倹 Web server running on port ${PORT}`);

// 繝倥Ν繧ｹ繝√ぉ繝・け cron・・0蛻・＃縺ｨ・・const HEALTH_CHECK_URL = process.env.HEALTH_CHECK_URL || `http://localhost:${PORT}`;
cron.schedule('*/10 * * * *', async () => {
  const now = new Date().toLocaleString('ja-JP');
  console.log(`剥 [${now}] 繝倥Ν繧ｹ繝√ぉ繝・け螳溯｡御ｸｭ... (${HEALTH_CHECK_URL})`);
  try {
    const res = await fetch(HEALTH_CHECK_URL);
    if (res.ok) console.log(`笨・[${now}] 繝倥Ν繧ｹ繝√ぉ繝・け謌仙粥: ${res.status}`);
    else console.warn(`笞・・[${now}] 繝倥Ν繧ｹ繝√ぉ繝・け螟ｱ謨・ ${res.status}`);
  } catch (err) {
    console.error(`笶・[${now}] 繝倥Ν繧ｹ繝√ぉ繝・け繧ｨ繝ｩ繝ｼ:`, err);
  }
}, { timezone: 'Asia/Tokyo' });

// ============================================================
// DB 蛻晄悄蛹・// ============================================================
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
// Google Calendar 繝倥Ν繝代・
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
      `迫 Discord繧､繝吶Φ繝・ https://discord.com/events/${GUILD_ID}/${event.id}`,
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
    console.log(`套 Google Calendar 縺ｫ霑ｽ蜉: "${discordEvent.name}"`);
  } catch (e) {
    console.error(`笶・Google Calendar 菴懈・螟ｱ謨・("${discordEvent.name}"):`, e.message);
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
    console.log(`売 Google Calendar 繧呈峩譁ｰ: "${discordEvent.name}"`);
  } catch (e) {
    if (e.code === 404) {
      delete db.data.eventMap[discordEvent.id];
      await db.write();
      await createCalendarEvent(discordEvent);
    } else {
      console.error(`笶・Google Calendar 譖ｴ譁ｰ螟ｱ謨・("${discordEvent.name}"):`, e.message);
    }
  }
}

async function deleteCalendarEvent(discordEventId, name = '荳肴・') {
  if (!calendarEnabled) return;
  const gcalId = db.data.eventMap[discordEventId];
  if (!gcalId) return;
  try {
    await calendar.events.delete({ calendarId: GOOGLE_CALENDAR_ID, eventId: gcalId });
    delete db.data.eventMap[discordEventId];
    await db.write();
    console.log(`卵・・Google Calendar 縺九ｉ蜑企勁: "${name}"`);
  } catch (e) {
    if (e.code === 410 || e.code === 404) {
      delete db.data.eventMap[discordEventId];
      await db.write();
    } else {
      console.error(`笶・Google Calendar 蜑企勁螟ｱ謨・("${name}"):`, e.message);
    }
  }
}

// ============================================================
// cron 繧ｸ繝ｧ繝也ｮ｡逅・// ============================================================
const jobs = [];
function registerCron(expr, jobFn, desc) {
  console.log(`竢ｰ Register cron [${expr}] for ${desc}`);
  const job = cron.schedule(expr, async () => {
    console.log(`笆ｶ Trigger cron [${expr}] for ${desc} at ${new Date().toLocaleString('ja-JP')}`);
    try { await jobFn(); }
    catch (e) { console.error(`笶・Job error (${desc}):`, e); }
  }, { timezone: 'Asia/Tokyo' });
  jobs.push(job);
}
function clearAllJobs() {
  jobs.forEach(j => j.stop());
  jobs.length = 0;
}

// ============================================================
// 繧､繝吶Φ繝亥叙蠕・// ============================================================
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
// 繝ｪ繝槭う繝ｳ繝峨Ο繧ｸ繝・け
// ============================================================
async function sendMorningSummary() {
  const guild   = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(ANNOUNCE_CHANNEL_ID);
  const events  = await fetchTodaysEvents(guild);
  if (events.size === 0) { console.log('働 譛ｬ譌･縺ｮ繧､繝吶Φ繝医・縺ゅｊ縺ｾ縺帙ｓ'); return; }

  let msg = '套 譛ｬ譌･縺ｮ繧､繝吶Φ繝井ｸ隕ｧ:\n';
  for (const e of events.values()) {
    const time     = new Date(e.scheduledStartTimestamp).toLocaleTimeString('ja-JP');
    const host     = e.creator?.username || '荳肴・';
    const chanUrl  = `https://discord.com/channels/${GUILD_ID}/${e.channelId}`;
    const eventUrl = `https://discord.com/events/${GUILD_ID}/${e.id}`;
    msg += `窶｢ ${e.name} / ${time} / ${host}\n` +
           `  桃 繝√Ε繝ｳ繝阪Ν: <${chanUrl}>\n` +
           `  迫 繧､繝吶Φ繝・   <${eventUrl}>\n`;
  }
  const reminder = await channel.send({ content: msg + '\n笨・蜃ｺ蟶ｭ・鞘搆 谺蟶ｭ 縺ｧ蜿ょ刈陦ｨ譏弱♀鬘倥＞縺励∪縺呻ｼ・ });
  await reminder.react('笨・);
  await reminder.react('笶・);
}

async function scheduleEventReminders() {
  const guild   = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(ANNOUNCE_CHANNEL_ID);
  const events  = await fetchTodaysEvents(guild);

  for (const offset of db.data.reminderOffsets) {
    for (const e of events.values()) {
      const target   = new Date(e.scheduledStartTimestamp - offset * 60000);
      const expr     = `${target.getMinutes()} ${target.getHours()} ${target.getDate()} ${target.getMonth() + 1} *`;
      const chanUrl  = `https://discord.com/channels/${GUILD_ID}/${e.channelId}`;
      const eventUrl = `https://discord.com/events/${GUILD_ID}/${e.id}`;
      registerCron(expr, async () => {
        await channel.send(
          `竢ｰ **${offset}蛻・燕繝ｪ繝槭う繝ｳ繝・* 縲・{e.name}縲構n` +
          `桃 繝√Ε繝ｳ繝阪Ν: <${chanUrl}>\n` +
          `迫 繧､繝吶Φ繝・   <${eventUrl}>`
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
// 繝ｪ繧｢繝ｫ繧ｿ繧､繝繧､繝吶Φ繝域､懃衍
// ============================================================
client.on('guildScheduledEventCreate', async event => {
  if (event.guildId !== GUILD_ID) return;
  console.log(`・ New scheduled event: "${event.name}"`);
  await createCalendarEvent(event);

  for (const offset of db.data.reminderOffsets) {
    const target   = new Date(event.scheduledStartTimestamp - offset * 60000);
    const expr     = `${target.getMinutes()} ${target.getHours()} ${target.getDate()} ${target.getMonth() + 1} *`;
    const chanUrl  = `https://discord.com/channels/${GUILD_ID}/${event.channelId}`;
    const eventUrl = `https://discord.com/events/${GUILD_ID}/${event.id}`;
    registerCron(expr, async () => {
      const ch = await client.guilds.fetch(GUILD_ID).then(g => g.channels.fetch(ANNOUNCE_CHANNEL_ID));
      await ch.send(
        `竢ｰ **${offset}蛻・燕繝ｪ繝槭う繝ｳ繝・* 縲・{event.name}縲構n` +
        `桃 繝√Ε繝ｳ繝阪Ν: <${chanUrl}>\n` +
        `迫 繧､繝吶Φ繝・   <${eventUrl}>`
      );
    }, `new-event '${event.name}' -${offset}m`);
  }
});

client.on('guildScheduledEventUpdate', async (oldEvent, newEvent) => {
  if (newEvent.guildId !== GUILD_ID) return;
  console.log(`笨擾ｸ・Updated scheduled event: "${newEvent.name}"`);
  if (newEvent.status === 4) {
    await deleteCalendarEvent(newEvent.id, newEvent.name);
    return;
  }
  await updateCalendarEvent(newEvent);
});

client.on('guildScheduledEventDelete', async event => {
  if (event.guildId !== GUILD_ID) return;
  console.log(`卵・・Deleted scheduled event: "${event.name}"`);
  await deleteCalendarEvent(event.id, event.name);
});

// ============================================================
// 繧ｹ繝ｩ繝・す繝･繧ｳ繝槭Φ繝臥匳骭ｲ & Bot襍ｷ蜍・// ============================================================
client.once('ready', async () => {
  console.log(`笨・Logged in as ${client.user.tag}`);
  console.log(`   竊・morningTime     = ${db.data.morningTime}`);
  console.log(`   竊・offsets         = ${( db.data.reminderOffsets ?? [] ).join(',')}`);
  console.log(`   竊・calendarEnabled = ${calendarEnabled}`);

  const commands = [
    new SlashCommandBuilder().setName('ping').setDescription('Bot逍朱壹メ繧ｧ繝・け'),
    new SlashCommandBuilder()
      .setName('set-morning-time')
      .setDescription('譛昴Μ繝槭う繝ｳ繝峨・譎ょ綾繧定ｨｭ螳・)
      .addStringOption(opt => opt.setName('time').setDescription('HH:MM蠖｢蠑・).setRequired(true)),
    new SlashCommandBuilder()
      .setName('set-reminder-offset')
      .setDescription('繧､繝吶Φ繝医Μ繝槭う繝ｳ繝峨・蛻・燕繧定ｨｭ螳・)
      .addIntegerOption(opt => opt.setName('minutes').setDescription('菴募・蜑・).setRequired(true)),
    new SlashCommandBuilder()
      .setName('week-events')
      .setDescription('逶ｴ霑・騾ｱ髢薙・繧､繝吶Φ繝井ｸ隕ｧ繧定｡ｨ遉ｺ'),
    new SlashCommandBuilder()
      .setName('sync-calendar')
      .setDescription('莉雁ｾ後・Discord繧､繝吶Φ繝医ｒGoogle繧ｫ繝ｬ繝ｳ繝繝ｼ縺ｫ荳諡ｬ蜷梧悄縺吶ｋ'),
  ].map(cmd => cmd.toJSON());

  await new REST({ version: '10' }).setToken(DISCORD_TOKEN)
    .put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
  console.log('笨・Slash commands registered');

  bootstrapSchedules();

  cron.schedule('* * * * *', () => {
    console.log('売 Polling & re-bootstrapping schedules');
    bootstrapSchedules();
  }, { timezone: 'Asia/Tokyo' });
});

// ============================================================
// 繧ｳ繝槭Φ繝峨ワ繝ｳ繝峨Λ
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
      return interaction.reply(`笨・譛昴Μ繝槭う繝ｳ繝峨ｒ **${time}** 縺ｫ險ｭ螳壹＠蜀咲匳骭ｲ縺励∪縺励◆`);
    }

    case 'set-reminder-offset': {
      const min = interaction.options.getInteger('minutes');
      db.data.reminderOffsets = [min];
      await db.write();
      bootstrapSchedules();
      return interaction.reply(`笨・繝ｪ繝槭う繝ｳ繝峨ｒ **${min}蛻・燕** 縺ｫ險ｭ螳壹＠蜀咲匳骭ｲ縺励∪縺励◆`);
    }

    case 'week-events': {
      const guild  = await client.guilds.fetch(GUILD_ID);
      const events = await fetchWeekEvents(guild);
      if (events.size === 0) return interaction.reply('働 莉雁ｾ・騾ｱ髢薙・繧､繝吶Φ繝医・縺ゅｊ縺ｾ縺帙ｓ');

      let msg = '宕 莉雁ｾ・騾ｱ髢薙・繧､繝吶Φ繝井ｸ隕ｧ:\n';
      for (const e of events.values()) {
        const ts = new Date(e.scheduledStartTimestamp).toLocaleString('ja-JP', {
          weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit'
        });
        const host     = e.creator?.username || '荳肴・';
        const chanUrl  = `https://discord.com/channels/${GUILD_ID}/${e.channelId}`;
        const eventUrl = `https://discord.com/events/${GUILD_ID}/${e.id}`;
        msg += `窶｢ ${e.name} / ${ts} / ${host}\n` +
               `  桃 繝√Ε繝ｳ繝阪Ν: <${chanUrl}>\n` +
               `  迫 繧､繝吶Φ繝・   <${eventUrl}>\n`;
      }
      return interaction.reply(msg);
    }

    case 'sync-calendar': {
      if (!calendarEnabled) return interaction.reply('笞・・Google Calendar 騾｣謳ｺ縺瑚ｨｭ螳壹＆繧後※縺・∪縺帙ｓ');
      await interaction.deferReply();
      const guild  = await client.guilds.fetch(GUILD_ID);
      const events = await fetchWeekEvents(guild);
      if (events.size === 0) return interaction.editReply('働 蜷梧悄縺吶ｋ繧､繝吶Φ繝医′縺ゅｊ縺ｾ縺帙ｓ');

      let created = 0, updated = 0;
      for (const e of events.values()) {
        if (db.data.eventMap[e.id]) { await updateCalendarEvent(e); updated++; }
        else { await createCalendarEvent(e); created++; }
      }
      return interaction.editReply(`笨・Google Calendar 蜷梧悄螳御ｺ・n縲譁ｰ隕冗匳骭ｲ: ${created}莉ｶ / 譖ｴ譁ｰ: ${updated}莉ｶ`);
    }
  }
});

// ============================================================
// Discord Bot 繝ｭ繧ｰ繧､繝ｳ
// ============================================================
client.login(DISCORD_TOKEN);
