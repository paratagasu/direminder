// 日時ヘルパー（サーバーのタイムゾーンに依存しないようJSTを明示的に扱う）
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

// JSTの年月日時分 → Date
export function jstDate(year, month, day, hour = 0, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0) - JST_OFFSET_MS);
}

// Date → JSTの各要素
export function jstParts(date = new Date()) {
  const j = new Date(new Date(date).getTime() + JST_OFFSET_MS);
  return {
    year: j.getUTCFullYear(), month: j.getUTCMonth() + 1, day: j.getUTCDate(),
    hour: j.getUTCHours(), minute: j.getUTCMinutes(), weekday: j.getUTCDay(),
  };
}

// 現在のJST年月日
export function nowJstParts() {
  const { year, month, day } = jstParts();
  return { year, month, day };
}

// 存在する日付か（2/31 などを弾く）
export function isValidDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

// 月日だけ指定された日付の年を決める（今日より前なら来年扱い）
export function resolveYear(month, day) {
  const n = nowJstParts();
  const today = Date.UTC(n.year, n.month - 1, n.day);
  return Date.UTC(n.year, month - 1, day) < today ? n.year + 1 : n.year;
}

// "HH:MM" → [h, m]（不正なら null）
export function parseHHMM(str) {
  const m = /^(\d{1,2})[:：](\d{2})$/.exec((str ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return [h, min];
}

export function formatHHMM(h, m) {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 指定日時に1回だけ発火するcron式（JST）
export function cronExprAt(date) {
  const j = jstParts(date);
  return `${j.minute} ${j.hour} ${j.day} ${j.month} *`;
}

export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export function getWeekday(year, month, day) {
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

export function formatJst(date, opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) {
  return new Date(date).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', ...opts });
}
