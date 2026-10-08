// メンバーカレンダー（予定の確認・追加・削除）
import { SlashCommandBuilder } from 'discord.js';
import { db } from '../db.js';
import { calendar, calendarEnabled, queryMemberCalendars, formatCalendarResults, findFreeSlots } from '../calendar.js';
import { getMembers } from '../members.js';
import { findMemberByDiscordId } from '../members.js';
import { jstDate, nowJstParts, isValidDate, resolveYear, parseHHMM, getWeekday, formatHHMM, jstParts, WEEKDAYS } from '../time.js';
import { replyLong } from '../util.js';

export const commands = [
  {
    data: new SlashCommandBuilder().setName('tm').setDescription('指定日時のメンバーカレンダーを確認')
      .addIntegerOption(o => o.setName('month').setDescription('月').setRequired(true).setMinValue(1).setMaxValue(12))
      .addIntegerOption(o => o.setName('day').setDescription('日').setRequired(true).setMinValue(1).setMaxValue(31))
      .addStringOption(o => o.setName('time').setDescription('時刻（例: 20:00）').setRequired(true)),
    async execute(interaction) {
      if (!calendarEnabled) return interaction.reply('⚠️ Calendar未設定');
      const month = interaction.options.getInteger('month');
      const day   = interaction.options.getInteger('day');
      const parsed = parseHHMM(interaction.options.getString('time'));
      if (!parsed) return interaction.reply({ content: '❌ 時刻は HH:MM 形式（例: 20:00）で指定してください', flags: 64 });
      const [h]   = parsed;
      const year  = resolveYear(month, day);
      if (!isValidDate(year, month, day)) return interaction.reply({ content: `❌ ${month}/${day} は存在しない日付です`, flags: 64 });
      await interaction.deferReply();
      const target = { year, month, day };
      const weekday = getWeekday(target.year, target.month, target.day);
      const label = `**${month}/${day}(${weekday}) ${h}:00**`;
      const results = await queryMemberCalendars(target, h);
      return interaction.editReply(formatCalendarResults(results, label));
    },
  },
  {
    data: new SlashCommandBuilder().setName('tm-week').setDescription('本日から1週間の指定時刻のカレンダーを確認')
      .addStringOption(o => o.setName('time').setDescription('時刻（例: 20:00）').setRequired(true)),
    async execute(interaction) {
      if (!calendarEnabled) return interaction.reply('⚠️ Calendar未設定');
      const parsed = parseHHMM(interaction.options.getString('time'));
      if (!parsed) return interaction.reply({ content: '❌ 時刻は HH:MM 形式（例: 20:00）で指定してください', flags: 64 });
      const [h] = parsed;
      await interaction.deferReply();
      const today = nowJstParts();
      let msg = '';
      for (let i = 0; i < 7; i++) {
        const d = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
        const target = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
        const weekday = getWeekday(target.year, target.month, target.day);
        const label = `**${target.month}/${target.day}(${weekday}) ${h}:00**`;
        const results = await queryMemberCalendars(target, h);
        msg += formatCalendarResults(results, label) + '\n\n';
      }
      return replyLong(interaction, msg.trim());
    },
  },
  {
    data: new SlashCommandBuilder().setName('cal-add').setDescription('Googleカレンダーに予定を追加（単一予定）')
      .addIntegerOption(o => o.setName('month').setDescription('月').setRequired(true).setMinValue(1).setMaxValue(12))
      .addIntegerOption(o => o.setName('day').setDescription('日').setRequired(true).setMinValue(1).setMaxValue(31))
      .addStringOption(o => o.setName('start-time').setDescription('開始時刻（例: 19:00）').setRequired(true))
      .addStringOption(o => o.setName('end-time').setDescription('終了時刻（例: 21:00）').setRequired(true))
      .addStringOption(o => o.setName('title').setDescription('予定名（空欄で「予定」）').setRequired(false)),
    async execute(interaction) {
      if (!calendarEnabled) return interaction.reply('⚠️ Calendar未設定');
      const memberCfg = findMemberByDiscordId(interaction.user.id);
      if (!memberCfg) return interaction.reply({ content: '⚠️ あなたのカレンダーが設定されていません', flags: 64 });

      const month     = interaction.options.getInteger('month');
      const day       = interaction.options.getInteger('day');
      const startTime = interaction.options.getString('start-time');
      const endTime   = interaction.options.getString('end-time');
      const rawTitle  = interaction.options.getString('title') || '予定';
      const title     = `${memberCfg.label}${rawTitle}`;

      const startParsed = parseHHMM(startTime);
      const endParsed   = parseHHMM(endTime);
      if (!startParsed || !endParsed) return interaction.reply({ content: '❌ 時刻は HH:MM 形式（例: 19:00）で指定してください', flags: 64 });
      const year = resolveYear(month, day);
      if (!isValidDate(year, month, day)) return interaction.reply({ content: `❌ ${month}/${day} は存在しない日付です`, flags: 64 });

      const startDt = jstDate(year, month, day, ...startParsed);
      let   endDt   = jstDate(year, month, day, ...endParsed);
      // 終了が開始以前なら日付をまたぐ予定として翌日扱い（例: 23:00〜01:00）
      const overnight = endDt <= startDt;
      if (overnight) endDt = new Date(endDt.getTime() + 24 * 60 * 60 * 1000);

      await interaction.deferReply();
      try {
        await calendar.events.insert({
          calendarId: memberCfg.calendarId,
          resource: {
            summary: title,
            start: { dateTime: startDt.toISOString(), timeZone: 'Asia/Tokyo' },
            end:   { dateTime: endDt.toISOString(),   timeZone: 'Asia/Tokyo' },
          },
        });
        return interaction.editReply(`✅ 「${title}」を ${year}/${month}/${day} ${startTime}〜${overnight ? '翌' : ''}${endTime} に追加しました`);
      } catch (e) { return interaction.editReply(`❌ 追加失敗: ${e.message}`); }
    },
  },
  {
    data: new SlashCommandBuilder().setName('cal-add-allday').setDescription('Googleカレンダーに終日予定を追加')
      .addIntegerOption(o => o.setName('start-month').setDescription('開始月').setRequired(true).setMinValue(1).setMaxValue(12))
      .addIntegerOption(o => o.setName('start-day').setDescription('開始日').setRequired(true).setMinValue(1).setMaxValue(31))
      .addIntegerOption(o => o.setName('end-month').setDescription('終了月').setRequired(true).setMinValue(1).setMaxValue(12))
      .addIntegerOption(o => o.setName('end-day').setDescription('終了日').setRequired(true).setMinValue(1).setMaxValue(31))
      .addStringOption(o => o.setName('title').setDescription('予定名（空欄で「予定」）').setRequired(false)),
    async execute(interaction) {
      if (!calendarEnabled) return interaction.reply('⚠️ Calendar未設定');
      const memberCfg = findMemberByDiscordId(interaction.user.id);
      if (!memberCfg) return interaction.reply({ content: '⚠️ カレンダーが設定されていません', flags: 64 });

      const sm       = interaction.options.getInteger('start-month');
      const sd       = interaction.options.getInteger('start-day');
      const em       = interaction.options.getInteger('end-month');
      const ed       = interaction.options.getInteger('end-day');
      const rawTitle = interaction.options.getString('title') || '予定';
      const title    = `${memberCfg.label}${rawTitle}`;
      const year     = resolveYear(sm, sd);
      // 終了月日が開始より前なら年をまたぐ予定（例: 12/30〜1/2）
      const endYear  = Date.UTC(year, em - 1, ed) < Date.UTC(year, sm - 1, sd) ? year + 1 : year;
      if (!isValidDate(year, sm, sd) || !isValidDate(endYear, em, ed)) {
        return interaction.reply({ content: '❌ 存在しない日付が指定されています', flags: 64 });
      }

      // 終日予定の終了日はGoogle Calendar的に「翌日」を指定
      const endDate = new Date(Date.UTC(endYear, em - 1, ed + 1));
      const endDateStr = `${endDate.getUTCFullYear()}-${String(endDate.getUTCMonth()+1).padStart(2,'0')}-${String(endDate.getUTCDate()).padStart(2,'0')}`;
      const startDateStr = `${year}-${String(sm).padStart(2,'0')}-${String(sd).padStart(2,'0')}`;

      await interaction.deferReply();
      try {
        await calendar.events.insert({
          calendarId: memberCfg.calendarId,
          resource: {
            summary: title,
            start: { date: startDateStr },
            end:   { date: endDateStr },
          },
        });
        return interaction.editReply(`✅ 「${title}」を ${year}/${sm}/${sd}〜${endYear}/${em}/${ed} の終日予定として追加しました`);
      } catch (e) { return interaction.editReply(`❌ 追加失敗: ${e.message}`); }
    },
  },
  {
    data: new SlashCommandBuilder().setName('cal-delete').setDescription('Googleカレンダーの予定を削除')
      .addIntegerOption(o => o.setName('weeks').setDescription('何週間先まで表示するか（1〜）').setRequired(true).setMinValue(1).setMaxValue(52)),
    async execute(interaction) {
      if (!calendarEnabled) return interaction.reply('⚠️ Calendar未設定');
      const memberCfg = findMemberByDiscordId(interaction.user.id);
      if (!memberCfg) return interaction.reply({ content: '⚠️ カレンダーが設定されていません', flags: 64 });

      const weeks = interaction.options.getInteger('weeks');
      const today = nowJstParts();
      const timeMin = jstDate(today.year, today.month, today.day);
      const timeMax = new Date(timeMin.getTime() + weeks * 7 * 24 * 60 * 60 * 1000);

      await interaction.deferReply();
      try {
        // リアクションで選べるのは10件まで
        const res = await calendar.events.list({
          calendarId: memberCfg.calendarId,
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 10,
        });
        const events = res.data.items ?? [];

        const numberEmojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];

        if (events.length === 0) return interaction.editReply('📭 予定がありません');

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
        if (res.data.nextPageToken) msg += '（11件目以降は表示されません。期間を短くしてください）\n';
        msg += '\n数字リアクションで削除する予定を選択してください。❌でキャンセル。';

        const sentMsg = await interaction.editReply({ content: msg });

        // リアクションを付け終わる前に押されても反応できるよう、先にセッションを保存する
        db.data.pendingDeleteSessions[interaction.user.id] = {
          msgId: sentMsg.id,
          requesterId: interaction.user.id,
          events: events.map(ev => ({ id: ev.id, summary: ev.summary })),
          calendarId: memberCfg.calendarId,
        };
        await db.write();

        await sentMsg.react('❌');
        for (let i = 0; i < events.length; i++) {
          await sentMsg.react(numberEmojis[i]);
        }
      } catch (e) {
        return interaction.editReply(`❌ 取得失敗: ${e.message}`).catch(() => {});
      }
      return;
    },
  },
  {
    data: new SlashCommandBuilder().setName('tm-free').setDescription('メンバー全員（または指定人数以上）が空いている時間帯を探す')
      .addIntegerOption(o => o.setName('min-members').setDescription('最低何人空いていればよいか（省略で全員）').setMinValue(1).setMaxValue(50))
      .addIntegerOption(o => o.setName('duration').setDescription('必要な長さ（省略で60分）')
        .addChoices({ name: '30分', value: 30 }, { name: '1時間', value: 60 }, { name: '1時間半', value: 90 },
                    { name: '2時間', value: 120 }, { name: '3時間', value: 180 }))
      .addIntegerOption(o => o.setName('start-hour').setDescription('探す時間帯の開始（時・省略で19時）').setMinValue(0).setMaxValue(23))
      .addIntegerOption(o => o.setName('end-hour').setDescription('探す時間帯の終了（時・24で深夜0時・省略で24時）').setMinValue(1).setMaxValue(24))
      .addIntegerOption(o => o.setName('days').setDescription('今日から何日分探すか（省略で7日）').setMinValue(1).setMaxValue(14))
      .addBooleanOption(o => o.setName('ignore-allday').setDescription('終日予定を無視する（省略時は終日予定も「予定あり」扱い）')),
    async execute(interaction) {
      if (!calendarEnabled) return interaction.reply('⚠️ Calendar未設定');
      const total = getMembers().filter(m => m.calendarId).length;
      if (total === 0) return interaction.reply({ content: '⚠️ カレンダーが登録されたメンバーがいません（/member-add で登録）', flags: 64 });
      const duration  = interaction.options.getInteger('duration') ?? 60;
      const startHour = interaction.options.getInteger('start-hour') ?? 19;
      const endHour   = interaction.options.getInteger('end-hour') ?? 24;
      const days      = interaction.options.getInteger('days') ?? 7;
      const minOpt    = interaction.options.getInteger('min-members');
      const includeAllDay = !(interaction.options.getBoolean('ignore-allday') ?? false);
      if (endHour <= startHour) return interaction.reply({ content: '❌ end-hour は start-hour より後にしてください', flags: 64 });
      if ((endHour - startHour) * 60 < duration) return interaction.reply({ content: '❌ 時間帯が必要な長さより短いです', flags: 64 });
      await interaction.deferReply();

      const { result, failed, total: counted, need } = await findFreeSlots({ days, startHour, endHour, duration, minMembers: minOpt, includeAllDay });
      const durLabel = duration % 60 === 0 ? `${duration / 60}時間` : `${duration}分`;
      const lines = [
        `🔍 **空き時間検索**（${days}日間・${startHour}:00〜${endHour}:00・${durLabel}以上・${need === counted ? '全員' : `${need}人以上`}）`,
      ];
      if (failed.length) lines.push(`⚠️ 取得できなかったカレンダー: ${failed.join('、')}（集計から除外）`);
      let found = 0;
      for (const { date, ranges } of result) {
        if (ranges.length === 0) continue;
        lines.push('', `**${date.month}/${date.day}(${WEEKDAYS[date.weekday]})**`);
        for (const r of ranges) {
          const s = jstParts(r.start), e = jstParts(r.end);
          const endLabel = (e.day !== s.day && e.hour === 0 && e.minute === 0) ? '24:00' : formatHHMM(e.hour, e.minute);
          const who = r.free.length === counted ? `✅ 全員OK（${counted}人）` : `🟡 ${r.free.length}/${counted}人（✖ ${r.notFree.join('、')}）`;
          lines.push(`　${formatHHMM(s.hour, s.minute)}〜${endLabel}　${who}`);
          found++;
        }
      }
      if (found === 0) lines.push('', '😢 条件に合う時間帯は見つかりませんでした。人数や時間帯を変えて試してください。');
      else lines.push('', `※ 各時間帯の中なら、どこから始めても${durLabel}確保できます`);
      return replyLong(interaction, lines.join('\n'));
    },
  },
];
