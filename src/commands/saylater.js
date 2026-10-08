// 伝言予約
import { SlashCommandBuilder } from 'discord.js';
import { db } from '../db.js';
import { DEFAULT_REMIND_CHANNEL_ID } from '../config.js';
import { stopJob } from '../cron.js';
import { jstDate, isValidDate, resolveYear, parseHHMM, WEEKDAYS } from '../time.js';
import {
  scheduleSaylaterJob, scheduleRepeatJob, describeRepeat, repeatNextRun, repeatJobList, sendRepeat, REPEAT_FREQS,
} from '../features/saylater.js';
import { isAdmin, replyLong, EPHEMERAL } from '../util.js';

export const commands = [
  {
    data: new SlashCommandBuilder().setName('saylatter-rel').setDescription('伝言予約：〇分後・〇時間後・〇日後に送信する')
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
    async execute(interaction) {
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
    },
  },
  {
    data: new SlashCommandBuilder().setName('saylatter-abs').setDescription('伝言予約：日付と時刻を指定して送信する')
      .addIntegerOption(o => o.setName('month').setDescription('月').setRequired(true).setMinValue(1).setMaxValue(12))
      .addIntegerOption(o => o.setName('day').setDescription('日').setRequired(true).setMinValue(1).setMaxValue(31))
      .addStringOption(o => o.setName('time').setDescription('時刻（例: 20:00）').setRequired(true))
      .addStringOption(o => o.setName('message').setDescription('リマインド本文').setRequired(true))
      .addUserOption(o => o.setName('mention').setDescription('メンション相手（デフォルト: 自分）').setRequired(false))
      .addChannelOption(o => o.setName('channel').setDescription('送信先チャンネル（デフォルト: いろいろ）').setRequired(false)),
    async execute(interaction) {
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
    },
  },
  {
    data: new SlashCommandBuilder().setName('saylatter-list').setDescription('設定中の伝言予約一覧を表示する'),
    async execute(interaction) {
      const jobs = Object.entries(db.data.saylaterJobs ?? {});
      if (jobs.length === 0) return interaction.reply({ content: '📭 設定中の伝言予約はありません', flags: 64 });
      let msg = `📬 **伝言予約一覧** (${jobs.length}件)\n\n`;
      jobs.forEach(([id, job], i) => {
        const fireAtJst = new Date(job.fireAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        msg += `${i+1}. ⏰ ${fireAtJst}\n　📝 ${job.message.slice(0, 30)}${job.message.length > 30 ? '…' : ''}\n　👤 <@${job.mentionId}> → <#${job.channelId}>\n\n`;
      });
      msg += '`/saylatter-cancel number:番号` でキャンセルできます';
      return interaction.reply({ content: msg, flags: 64 });
    },
  },
  {
    data: new SlashCommandBuilder().setName('saylatter-cancel').setDescription('伝言予約をキャンセルする')
      .addIntegerOption(o => o.setName('number').setDescription('キャンセルする番号（/saylatter-listで確認）').setRequired(true).setMinValue(1)),
    async execute(interaction) {
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
    },
  },
  // ============================================================
  // 定期伝言予約
  // ============================================================
  {
    data: new SlashCommandBuilder()
      .setName('saylatter-repeat-add').setDescription('定期伝言予約：毎日・平日・毎週・毎月の決まった時刻に送信する')
      .addStringOption(o => o.setName('frequency').setDescription('頻度').setRequired(true)
        .addChoices(...Object.entries(REPEAT_FREQS).map(([value, name]) => ({ name, value }))))
      .addStringOption(o => o.setName('time').setDescription('時刻（例: 20:00）').setRequired(true))
      .addStringOption(o => o.setName('message').setDescription('本文').setRequired(true).setMaxLength(1800))
      .addIntegerOption(o => o.setName('weekday').setDescription('曜日（「毎週」のとき必須）')
        .addChoices(...[1, 2, 3, 4, 5, 6, 0].map(d => ({ name: `${WEEKDAYS[d]}曜日`, value: d }))))
      .addIntegerOption(o => o.setName('day').setDescription('日にち（「毎月」のとき必須・その日が無い月は送信されません）').setMinValue(1).setMaxValue(31))
      .addUserOption(o => o.setName('mention').setDescription('メンション相手（省略で自分。メンションなしにするなら no-mention を指定）'))
      .addRoleOption(o => o.setName('mention-role').setDescription('メンションするロール（任意）'))
      .addBooleanOption(o => o.setName('no-mention').setDescription('ユーザーへのメンションを付けない'))
      .addChannelOption(o => o.setName('channel').setDescription('送信先チャンネル（デフォルト: いろいろ）')),
    async execute(interaction) {
      const freq    = interaction.options.getString('frequency');
      const parsed  = parseHHMM(interaction.options.getString('time'));
      const weekday = interaction.options.getInteger('weekday');
      const day     = interaction.options.getInteger('day');
      if (!parsed) return interaction.reply({ content: '❌ 時刻は HH:MM 形式（例: 20:00）で指定してください', flags: EPHEMERAL });
      if (freq === 'weekly' && weekday === null) return interaction.reply({ content: '❌ 「毎週」のときは weekday（曜日）を指定してください', flags: EPHEMERAL });
      if (freq === 'monthly' && day === null) return interaction.reply({ content: '❌ 「毎月（日付指定）」のときは day（日にち）を指定してください', flags: EPHEMERAL });
      const noMention = interaction.options.getBoolean('no-mention') ?? false;
      const job = {
        freq, hour: parsed[0], minute: parsed[1],
        weekday: freq === 'weekly' ? weekday : null,
        day: freq === 'monthly' ? day : null,
        message: interaction.options.getString('message'),
        mentionId: noMention ? null : (interaction.options.getUser('mention') ?? interaction.user).id,
        roleId: interaction.options.getRole('mention-role')?.id ?? null,
        channelId: interaction.options.getChannel('channel')?.id ?? DEFAULT_REMIND_CHANNEL_ID,
        createdBy: interaction.user.id,
        paused: false,
        createdAt: new Date().toISOString(),
      };
      db.data.repeatJobs[interaction.id] = job;
      await db.write();
      scheduleRepeatJob(interaction.id);
      const next = repeatNextRun(interaction.id);
      return interaction.reply({
        content: `✅ 定期伝言予約を設定しました\n　🔁 ${describeRepeat(job)}${next ? `（次回: ${next}）` : ''}\n　📝 ${job.message}\n` +
          `　👤 ${[job.mentionId && `<@${job.mentionId}>`, job.roleId && `<@&${job.roleId}>`].filter(Boolean).join(' ') || 'メンションなし'}\n　📍 <#${job.channelId}>` +
          (freq === 'monthly' && day > 28 ? `\n　⚠️ ${day}日が無い月は送信されません（月末にしたい場合は「毎月末」を選んでください）` : ''),
        allowedMentions: { parse: [] },
      });
    },
  },
  {
    data: new SlashCommandBuilder().setName('saylatter-repeat-list').setDescription('定期伝言予約の一覧を表示する'),
    async execute(interaction) {
      const jobs = repeatJobList();
      if (jobs.length === 0) return interaction.reply({ content: '📭 定期伝言予約はありません', flags: EPHEMERAL });
      await interaction.deferReply({ flags: EPHEMERAL });
      const lines = [`🔁 **定期伝言予約一覧** (${jobs.length}件)`, ''];
      jobs.forEach(([id, job], i) => {
        const next = job.paused ? '⏸ 一時停止中' : `次回: ${repeatNextRun(id) ?? '―'}`;
        lines.push(
          `**${i + 1}.** ${describeRepeat(job)}　${next}`,
          `　📝 ${job.message.slice(0, 40)}${job.message.length > 40 ? '…' : ''}`,
          `　👤 ${[job.mentionId && `<@${job.mentionId}>`, job.roleId && `<@&${job.roleId}>`].filter(Boolean).join(' ') || 'メンションなし'} → <#${job.channelId}>　作成: <@${job.createdBy}>`,
          '',
        );
      });
      lines.push('`/saylatter-repeat-pause` 一時停止・再開 / `/saylatter-repeat-test` テスト送信 / `/saylatter-repeat-delete` 削除');
      return replyLong(interaction, lines.join('\n'), { ephemeral: true });
    },
  },
  {
    data: new SlashCommandBuilder().setName('saylatter-repeat-pause').setDescription('定期伝言予約を一時停止／再開する')
      .addIntegerOption(o => o.setName('number').setDescription('番号（/saylatter-repeat-listで確認）').setRequired(true).setMinValue(1)),
    async execute(interaction) {
      const found = pickRepeat(interaction);
      if (!found.ok) return interaction.reply({ content: found.error, flags: EPHEMERAL });
      const { id, job } = found;
      job.paused = !job.paused;
      await db.write();
      scheduleRepeatJob(id);
      return interaction.reply({
        content: job.paused
          ? `⏸ 一時停止しました：${describeRepeat(job)}「${job.message.slice(0, 30)}」`
          : `▶️ 再開しました：${describeRepeat(job)}「${job.message.slice(0, 30)}」（次回: ${repeatNextRun(id) ?? '―'}）`,
        flags: EPHEMERAL,
      });
    },
  },
  {
    data: new SlashCommandBuilder().setName('saylatter-repeat-test').setDescription('定期伝言予約を今すぐ1回送信してテストする')
      .addIntegerOption(o => o.setName('number').setDescription('番号（/saylatter-repeat-listで確認）').setRequired(true).setMinValue(1)),
    async execute(interaction) {
      const found = pickRepeat(interaction);
      if (!found.ok) return interaction.reply({ content: found.error, flags: EPHEMERAL });
      await interaction.deferReply({ flags: EPHEMERAL });
      try { await sendRepeat(found.job); return interaction.editReply(`✅ <#${found.job.channelId}> にテスト送信しました`); }
      catch (e) { return interaction.editReply(`❌ 送信失敗: ${e.message}`); }
    },
  },
  {
    data: new SlashCommandBuilder().setName('saylatter-repeat-delete').setDescription('定期伝言予約を削除する')
      .addIntegerOption(o => o.setName('number').setDescription('番号（/saylatter-repeat-listで確認）').setRequired(true).setMinValue(1)),
    async execute(interaction) {
      const found = pickRepeat(interaction);
      if (!found.ok) return interaction.reply({ content: found.error, flags: EPHEMERAL });
      delete db.data.repeatJobs[found.id];
      await db.write();
      scheduleRepeatJob(found.id); // 存在しないので停止される
      return interaction.reply({ content: `🗑️ 削除しました：${describeRepeat(found.job)}「${found.job.message.slice(0, 30)}」`, flags: EPHEMERAL });
    },
  },
];

// 番号で定期伝言予約を選ぶ（作成者か管理者のみ操作可）
function pickRepeat(interaction) {
  const number = interaction.options.getInteger('number');
  const jobs = repeatJobList();
  if (number > jobs.length) return { ok: false, error: `❌ 番号 ${number} の定期伝言予約はありません（現在${jobs.length}件）` };
  const [id, job] = jobs[number - 1];
  if (job.createdBy !== interaction.user.id && !isAdmin(interaction)) {
    return { ok: false, error: '⛔ 作成者か管理者だけが操作できます' };
  }
  return { ok: true, id, job };
}
