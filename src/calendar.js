// Google Calendar 連携
import { google } from 'googleapis';
import { GOOGLE_SERVICE_ACCOUNT_KEY, GOOGLE_CALENDAR_ID, GUILD_ID } from './config.js';
import { client } from './client.js';
import { db } from './db.js';
import { getMembers } from './members.js';
import { jstDate, jstParts } from './time.js';

export let calendarEnabled = false;
export let calendar = null;

if (GOOGLE_SERVICE_ACCOUNT_KEY && GOOGLE_CALENDAR_ID) {
  try {
    const key = JSON.parse(GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.GoogleAuth({
      credentials: key,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    calendar = google.calendar({ version: 'v3', auth });
    calendarEnabled = true;
    console.log('✅ Google Calendar 連携が有効になりました');
  } catch (e) {
    console.error('⚠️ Google Calendar 初期化失敗:', e.message);
  }
}

export function toCalendarEvent(event) {
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
    extendedProperties: { private: { discordEventId: event.id } },
  };
}

export async function findCalendarEventByDiscordId(discordEventId) {
  if (!calendarEnabled) return null;
  try {
    const res = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      privateExtendedProperty: `discordEventId=${discordEventId}`,
      singleEvents: true,
      maxResults: 1,
    });
    const items = res.data.items ?? [];
    return items.length > 0 ? items[0] : null;
  } catch (e) {
    console.error('❌ カレンダー検索失敗:', e.message);
    return null;
  }
}

let calendarSyncRunning = false;
export async function syncAllEventsToCalendar() {
  if (!calendarEnabled) return;
  // 同期の多重実行で同じ予定が二重登録されるのを防ぐ
  if (calendarSyncRunning) return;
  calendarSyncRunning = true;
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const all = await guild.scheduledEvents.fetch();
    for (const e of all.values()) {
      let gcalId = db.data.eventMap[e.id];
      if (gcalId) {
        // DBにある → 更新（404なら再検索）
        await calendar.events.patch({
          calendarId: GOOGLE_CALENDAR_ID,
          eventId: gcalId,
          resource: toCalendarEvent(e),
        }).catch(async (err) => {
          if (err.code === 404 || err.code === 410) {
            delete db.data.eventMap[e.id];
            const existing = await findCalendarEventByDiscordId(e.id);
            if (existing) {
              db.data.eventMap[e.id] = existing.id;
              await calendar.events.patch({
                calendarId: GOOGLE_CALENDAR_ID,
                eventId: existing.id,
                resource: toCalendarEvent(e),
              }).catch(() => {});
            } else {
              const res = await calendar.events.insert({
                calendarId: GOOGLE_CALENDAR_ID,
                resource: toCalendarEvent(e),
              });
              db.data.eventMap[e.id] = res.data.id;
              console.log(`📅 再作成: "${e.name}"`);
            }
          }
        });
      } else {
        // DBにない → Calendarを検索して重複確認
        const existing = await findCalendarEventByDiscordId(e.id);
        if (existing) {
          db.data.eventMap[e.id] = existing.id;
          await calendar.events.patch({
            calendarId: GOOGLE_CALENDAR_ID,
            eventId: existing.id,
            resource: toCalendarEvent(e),
          }).catch(() => {});
          console.log(`🔁 既存イベント復元: "${e.name}"`);
        } else {
          const res = await calendar.events.insert({
            calendarId: GOOGLE_CALENDAR_ID,
            resource: toCalendarEvent(e),
          });
          db.data.eventMap[e.id] = res.data.id;
          console.log(`📅 新規追加: "${e.name}"`);
        }
      }
    }
    await db.write();
    console.log(`🔄 Googleカレンダー同期完了 (${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })})`);
  } catch (e) {
    console.error('❌ Googleカレンダー同期失敗:', e.message);
  } finally {
    calendarSyncRunning = false;
  }
}

export async function deleteCalendarEvent(discordEventId, name = '不明') {
  if (!calendarEnabled) return;
  let gcalId = db.data.eventMap[discordEventId];
  if (!gcalId) {
    const existing = await findCalendarEventByDiscordId(discordEventId);
    if (existing) gcalId = existing.id;
  }
  if (!gcalId) return;
  try {
    await calendar.events.delete({ calendarId: GOOGLE_CALENDAR_ID, eventId: gcalId });
    delete db.data.eventMap[discordEventId];
    await db.write();
    console.log(`🗑️ Calendarから削除: "${name}"`);
  } catch (e) {
    if (e.code === 410 || e.code === 404) { delete db.data.eventMap[discordEventId]; await db.write(); }
    else console.error(`❌ Calendar削除失敗:`, e.message);
  }
}

export async function writeParticipantsToCalendar(eventId, eventName) {
  if (!calendarEnabled) return;
  let gcalId = db.data.eventMap[eventId];
  if (!gcalId) {
    const existing = await findCalendarEventByDiscordId(eventId);
    if (existing) { gcalId = existing.id; db.data.eventMap[eventId] = gcalId; await db.write(); }
  }
  if (!gcalId) return;
  const session = db.data.activeVcSessions[eventId];
  if (!session) return;
  const excludeIds = db.data.vcExcludeUsers ?? [];
  const filteredIds = (session.participants ?? []).filter(id => !excludeIds.includes(id));
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const names = [];
    for (const uid of filteredIds) {
      const m = await guild.members.fetch(uid).catch(() => null);
      if (m) names.push(m.displayName);
    }
    const existing = await calendar.events.get({ calendarId: GOOGLE_CALENDAR_ID, eventId: gcalId });
    const oldDesc = existing.data.description || '';
    const newDesc = oldDesc + `\n\n🎙️ 参加者 (${names.length}名):\n` +
      (names.length > 0 ? names.map(n => `・${n}`).join('\n') : '（なし）');
    await calendar.events.patch({ calendarId: GOOGLE_CALENDAR_ID, eventId: gcalId, resource: { description: newDesc } });
    console.log(`📝 参加者書き込み: "${eventName}" (${names.length}名)`);
  } catch (e) { console.error(`❌ 参加者書き込み失敗:`, e.message); }
}

export async function queryMemberCalendars(target, targetHour) {
  if (!calendarEnabled) return [];
  const windowStart = jstDate(target.year, target.month, target.day, targetHour, 0);
  const windowEnd   = new Date(windowStart.getTime() + 60 * 60 * 1000);
  const results = [];
  for (const { name, calendarId: calId } of getMembers()) {
    if (!calId) continue;
    try {
      const res = await calendar.events.list({
        calendarId: calId,
        timeMin: windowStart.toISOString(),
        timeMax: windowEnd.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });
      for (const ev of (res.data.items ?? [])) {
        const isAllDay = !ev.start.dateTime;
        results.push({
          member: name,
          title: ev.summary,
          start: isAllDay ? ev.start.date : ev.start.dateTime,
          allDay: isAllDay,
        });
      }
    } catch (e) { console.error(`❌ ${name}カレンダー取得失敗:`, e.message); }
  }
  return results;
}

export function formatCalendarResults(results, dateLabel) {
  if (results.length === 0) return `${dateLabel}\nこの時間の予定はありません`;
  const lines = results.map(r => {
    if (r.allDay || (r.start && !r.start.includes('T'))) return `・【${r.member}】${r.title}\n　[終日]`;
    const time = new Date(r.start).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });
    return `・【${r.member}】${r.title}\n　${time}〜`;
  });
  return `${dateLabel}\nこの時間の予定は以下${results.length}件です\n${lines.join('\n')}`;
}

// ============================================================
// 空き時間検索（/tm-free）
// ============================================================

// 各メンバーの予定（埋まっている時間帯）を取得
// 戻り値: { busy: Map<name, {start,end}[]>, failed: string[] }
export async function fetchMemberBusy(timeMin, timeMax, { includeAllDay = true } = {}) {
  const busy = new Map();
  const failed = [];
  await Promise.all(getMembers().filter(m => m.calendarId).map(async (m) => {
    try {
      const intervals = [];
      let pageToken;
      do {
        const res = await calendar.events.list({
          calendarId: m.calendarId,
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 250,
          pageToken,
        });
        for (const ev of res.data.items ?? []) {
          if (ev.status === 'cancelled') continue;
          if (ev.start?.date) {
            // 終日予定: JSTの開始日0時〜終了日0時（終了日は翌日表記）
            if (!includeAllDay) continue;
            const [sy, sm, sd] = ev.start.date.split('-').map(Number);
            const [ey, em, ed] = ev.end.date.split('-').map(Number);
            intervals.push({ start: jstDate(sy, sm, sd).getTime(), end: jstDate(ey, em, ed).getTime() });
          } else if (ev.start?.dateTime) {
            // 「予定なし（空き時間）」として登録された予定は除外
            if (ev.transparency === 'transparent') continue;
            intervals.push({ start: new Date(ev.start.dateTime).getTime(), end: new Date(ev.end.dateTime).getTime() });
          }
        }
        pageToken = res.data.nextPageToken;
      } while (pageToken);
      busy.set(m.name, intervals);
    } catch (e) {
      console.error(`❌ ${m.name}カレンダー取得失敗:`, e.message);
      failed.push(m.name);
    }
  }));
  return { busy, failed };
}

// 空いている時間帯を探す
// days: 今日から何日分 / startHour〜endHour: 1日のうち探す時間帯（endHour=24 は深夜0時）
// duration: 必要な長さ（分） / minMembers: 最低何人空いていればよいか
export async function findFreeSlots({ days = 7, startHour = 19, endHour = 24, duration = 60, minMembers = null, includeAllDay = true }) {
  const STEP_MS = 30 * 60 * 1000;
  const durMs = duration * 60 * 1000;
  const today = jstParts();
  const rangeStart = jstDate(today.year, today.month, today.day, startHour);
  const rangeEnd   = jstDate(today.year, today.month, today.day + days - 1, endHour);
  const { busy, failed } = await fetchMemberBusy(rangeStart, rangeEnd, { includeAllDay });
  const names = [...busy.keys()];
  const need = Math.min(minMembers ?? names.length, names.length);
  const now = Date.now();

  const result = []; // { dayStart, ranges: [{ start, end, free: [], notFree: [] }] }
  for (let i = 0; i < days; i++) {
    const winStart = jstDate(today.year, today.month, today.day + i, startHour).getTime();
    const winEnd   = jstDate(today.year, today.month, today.day + i, endHour).getTime();
    const ranges = [];
    let cur = null;
    for (let t = winStart; t + durMs <= winEnd; t += STEP_MS) {
      if (t < now) { cur = null; continue; }
      const free = names.filter(n => !busy.get(n).some(b => b.start < t + durMs && b.end > t));
      const ok = names.length > 0 && free.length >= need;
      const key = free.join(',');
      if (ok && cur && cur.key === key && cur.lastT + STEP_MS === t) {
        cur.end = t + durMs; cur.lastT = t;
      } else if (ok) {
        cur = { key, start: t, end: t + durMs, lastT: t, free, notFree: names.filter(n => !free.includes(n)) };
        ranges.push(cur);
      } else {
        cur = null;
      }
    }
    result.push({ date: jstParts(winStart), ranges });
  }
  return { result, failed, total: names.length, need };
}
