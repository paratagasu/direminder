// イベントリマインド設定・除外ユーザー
import { SlashCommandBuilder, AttachmentBuilder } from 'discord.js';
import { client } from '../client.js';
import { db } from '../db.js';
import { GUILD_ID } from '../config.js';
import { jobMap } from '../cron.js';
import { parseHHMM, formatHHMM } from '../time.js';
import { replyLong } from '../util.js';
import { calendarEnabled, syncAllEventsToCalendar } from '../calendar.js';
import { fetchWeekEvents, sendMorningSummary, EVENT_JOB_PREFIX } from '../features/events.js';
import { bootstrapSchedules } from '../schedules.js';

export const commands = [
  {
    data: new SlashCommandBuilder().setName('set-morning-time').setDescription('朝リマインドの時刻を設定')
      .addStringOption(o => o.setName('time').setDescription('HH:MM形式').setRequired(true)),
    async execute(interaction) {
      const parsed = parseHHMM(interaction.options.getString('time'));
      if (!parsed) return interaction.reply({ content: '❌ 時刻は HH:MM 形式（例: 07:00）で指定してください', flags: 64 });
      const time = formatHHMM(...parsed);
      db.data.morningTime = time;
      await db.write();
      bootstrapSchedules();
      return interaction.reply(`✅ 朝リマインドを **${time}** に設定しました`);
    },
  },
  {
    data: new SlashCommandBuilder().setName('add-reminder-offset').setDescription('リマインド時刻を追加')
      .addIntegerOption(o => o.setName('minutes').setDescription('何分前').setRequired(true)),
    async execute(interaction) {
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
    },
  },
  {
    data: new SlashCommandBuilder().setName('remove-reminder-offset').setDescription('リマインド時刻を削除')
      .addIntegerOption(o => o.setName('minutes').setDescription('何分前').setRequired(true)),
    async execute(interaction) {
      const min = interaction.options.getInteger('minutes');
      const idx = (db.data.reminderOffsets ?? []).indexOf(min);
      if (idx !== -1) {
        db.data.reminderOffsets.splice(idx, 1);
        await db.write();
        bootstrapSchedules();
        return interaction.reply(`✅ **${min}分前** を削除（現在: ${db.data.reminderOffsets.join(', ')}分前）`);
      }
      return interaction.reply(`ℹ️ **${min}分前** は設定されていません`);
    },
  },
  {
    data: new SlashCommandBuilder().setName('list-reminder-offsets').setDescription('リマインド時刻一覧'),
    async execute(interaction) {
      const o = db.data.reminderOffsets ?? [];
      return interaction.reply(o.length === 0 ? '📭 未設定' : `⏰ 現在: **${o.join(', ')}分前**`);
    },
  },
  {
    data: new SlashCommandBuilder().setName('week-events').setDescription('直近1週間のイベント一覧'),
    async execute(interaction) {
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
    },
  },
  {
    data: new SlashCommandBuilder().setName('sync-calendar').setDescription('Googleカレンダーに一括同期'),
    async execute(interaction) {
      if (!calendarEnabled) return interaction.reply('⚠️ Calendar未設定');
      await interaction.deferReply({ flags: 64 });
      await syncAllEventsToCalendar();
      return interaction.editReply('✅ 同期完了');
    },
  },
  {
    data: new SlashCommandBuilder().setName('force-remind').setDescription('朝リマインドを今すぐ送信（@everyoneあり）'),
    async execute(interaction) {
      await interaction.deferReply({ flags: 64 });
      await sendMorningSummary(true);
      return interaction.editReply('✅ 送信しました（@everyoneあり）');
    },
  },
  {
    data: new SlashCommandBuilder().setName('n-force-remind').setDescription('朝リマインドを今すぐ送信（@everyoneなし）'),
    async execute(interaction) {
      await interaction.deferReply({ flags: 64 });
      await sendMorningSummary(false);
      return interaction.editReply('✅ 送信しました（@everyoneなし）');
    },
  },
  {
    data: new SlashCommandBuilder().setName('debug-events').setDescription('Botが把握しているイベント情報を表示する'),
    async execute(interaction) {
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
    },
  },
  {
    data: new SlashCommandBuilder().setName('exclude-user-add').setDescription('参加者記録の除外ユーザーを追加')
      .addUserOption(o => o.setName('user').setDescription('ユーザー').setRequired(true)),
    async execute(interaction) {
      const user = interaction.options.getUser('user');
      db.data.vcExcludeUsers ??= [];
      if (!db.data.vcExcludeUsers.includes(user.id)) {
        db.data.vcExcludeUsers.push(user.id);
        await db.write();
        return interaction.reply(`✅ ${user.username} を除外リストに追加しました`);
      }
      return interaction.reply(`ℹ️ すでに登録されています`);
    },
  },
  {
    data: new SlashCommandBuilder().setName('exclude-user-remove').setDescription('除外ユーザーを解除')
      .addUserOption(o => o.setName('user').setDescription('ユーザー').setRequired(true)),
    async execute(interaction) {
      const user = interaction.options.getUser('user');
      const idx = (db.data.vcExcludeUsers ?? []).indexOf(user.id);
      if (idx !== -1) { db.data.vcExcludeUsers.splice(idx, 1); await db.write(); return interaction.reply(`✅ 除外リストから削除しました`); }
      return interaction.reply(`ℹ️ 登録されていません`);
    },
  },
  {
    data: new SlashCommandBuilder().setName('exclude-user-list').setDescription('除外ユーザー一覧'),
    async execute(interaction) {
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
    },
  },
  {
    data: new SlashCommandBuilder().setName('exclude-user-export').setDescription('除外リストをJSONでエクスポート'),
    async execute(interaction) {
      const buf = Buffer.from(JSON.stringify({ vcExcludeUsers: db.data.vcExcludeUsers ?? [] }, null, 2), 'utf-8');
      return interaction.reply({ content: '📤 エクスポートしました', files: [new AttachmentBuilder(buf, { name: 'exclude-users.json' })], flags: 64 });
    },
  },
  {
    data: new SlashCommandBuilder().setName('exclude-user-import').setDescription('除外リストをJSONからインポート')
      .addAttachmentOption(o => o.setName('file').setDescription('JSONファイル').setRequired(true)),
    async execute(interaction) {
      const att = interaction.options.getAttachment('file');
      await interaction.deferReply();
      try {
        const json = await (await fetch(att.url)).json();
        if (!Array.isArray(json.vcExcludeUsers)) return interaction.editReply('❌ 形式が正しくありません');
        db.data.vcExcludeUsers = json.vcExcludeUsers;
        await db.write();
        return interaction.editReply(`✅ インポートしました（${json.vcExcludeUsers.length}名）`);
      } catch (e) { return interaction.editReply(`❌ 失敗: ${e.message}`); }
    },
  },
];
