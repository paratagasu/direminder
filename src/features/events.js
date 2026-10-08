// イベント管理：朝リマインド・出欠（ボタン）・各種リマインド・VC参加記録
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Events } from 'discord.js';
import { joinVoiceChannel, getVoiceConnection } from '@discordjs/voice';
import { client } from '../client.js';
import { db } from '../db.js';
import { GUILD_ID, ANNOUNCE_CHANNEL_ID } from '../config.js';
import { registerCron, stopJob, jobMap } from '../cron.js';
import { cronExprAt, jstParts } from '../time.js';
import { getMembers } from '../members.js';
import { EPHEMERAL } from '../util.js';
import { deleteCalendarEvent, writeParticipantsToCalendar } from '../calendar.js';
import { getGjPoints, checkAchievements, ensureMonthlyCounter } from '../gj.js';

const STATUS_SCHEDULED = 1, STATUS_ACTIVE = 2, STATUS_COMPLETED = 3, STATUS_CANCELED = 4;

// ============================================================
// イベント取得
// ============================================================
function jstDateKey(ts) {
  const p = jstParts(ts);
  return `${p.year}-${p.month}-${p.day}`;
}

export async function fetchTodaysEvents(guild) {
  const all = await guild.scheduledEvents.fetch();
  const today = jstDateKey(Date.now());
  return all.filter(e => jstDateKey(e.scheduledStartTimestamp) === today);
}

export async function fetchWeekEvents(guild) {
  const now = Date.now();
  const weekLater = now + 7 * 24 * 60 * 60 * 1000;
  const all = await guild.scheduledEvents.fetch();
  return all.filter(e => e.scheduledStartTimestamp >= now && e.scheduledStartTimestamp <= weekLater);
}

// VC/ステージのイベントはチャンネルリンク、外部イベントは場所を表示
export function eventPlace(e) {
  if (e.channelId) return `<https://discord.com/channels/${GUILD_ID}/${e.channelId}>`;
  return e.entityMetadata?.location || '（未設定）';
}

function eventUrl(e) { return `https://discord.com/events/${GUILD_ID}/${e.id}`; }

// ============================================================
// ロール管理
// ============================================================
export async function getOrCreateEventRole(guild, event) {
  const existingRoleId = db.data.eventRoles[event.id];
  if (existingRoleId) {
    const role = guild.roles.cache.get(existingRoleId) || await guild.roles.fetch(existingRoleId).catch(() => null);
    if (role) return role;
  }
  await guild.roles.fetch();
  const existing = guild.roles.cache.find(r => r.name === `参加予定_${event.name}`);
  if (existing) { db.data.eventRoles[event.id] = existing.id; await db.write(); return existing; }
  const role = await guild.roles.create({
    name: `参加予定_${event.name}`,
    color: 0x57F287,
    reason: `イベント「${event.name}」用`,
  });
  db.data.eventRoles[event.id] = role.id;
  await db.write();
  console.log(`🎭 ロール作成: "${role.name}"`);
  return role;
}

export async function deleteEventRole(guild, eventId) {
  const roleId = db.data.eventRoles[eventId];
  if (!roleId) return;
  try {
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (role) await role.delete();
  } catch (e) { /* 削除済みなど */ }
  delete db.data.eventRoles[eventId];
  await db.write();
}

async function stripAllEventRoles(guild) {
  await guild.roles.fetch();
  const targets = guild.roles.cache.filter(r => r.name.startsWith('参加予定_'));
  for (const role of targets.values()) {
    try { await role.delete('前日ロール削除'); console.log(`🗑️ ロール削除: ${role.name}`); }
    catch (e) { console.error(`❌ ロール削除失敗:`, e.message); }
  }
  db.data.eventRoles = {};
  await db.write();
  console.log('🧹 前日ロールを全削除しました');
}

// ============================================================
// 出欠（ボタン）
// ============================================================
// db.data.attendance[eventId] = { eventName, info: { name, url, time, place, host }, yes: [], no: [], names: {}, channelId, msgId }
// 出欠はイベントごとの埋め込みカード1枚で表示し、ボタンが押されるたびにカードを書き換える

// カードの帯の色
export const CARD_COLORS = { open: 0x57F287, ended: 0x99AAB5, canceled: 0xED4245 };

function buildInfo(e) {
  return {
    name: e.name,
    url: eventUrl(e),
    time: new Date(e.scheduledStartTimestamp).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }),
    place: e.channelId ? `🔊 <#${e.channelId}>` : `📍 ${e.entityMetadata?.location || '場所未設定'}`,
    host: e.creator?.username || '不明',
  };
}

export function attendanceButtons(eventId, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`att:yes:${eventId}`).setLabel('出席').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`att:no:${eventId}`).setLabel('欠席').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  )];
}

// 出欠をメンバー名単位で集計する。
// アカウントを複数持つメンバーは、どれか1つでも反応していれば回答済み（出席が欠席より優先）
export function summarizeAttendance(att) {
  const yes = [], no = [], unanswered = [];
  const seen = new Set();
  for (const m of getMembers()) {
    const ids = m.discordIds ?? [];
    ids.forEach(id => seen.add(id));
    if (ids.some(id => att.yes.includes(id))) yes.push(m.name);
    else if (ids.some(id => att.no.includes(id))) no.push(m.name);
    else unanswered.push({ name: m.name, id: ids[0] });
  }
  // メンバー表にいない人（ゲストなど）
  for (const id of att.yes) if (!seen.has(id)) yes.push(att.names?.[id] ?? `<@${id}>`);
  for (const id of att.no)  if (!seen.has(id)) no.push(att.names?.[id] ?? `<@${id}>`);
  return { yes, no, unanswered };
}

// 埋め込みのフィールドは1024文字まで
function nameList(names) {
  if (names.length === 0) return '―';
  let out = '';
  for (let i = 0; i < names.length; i++) {
    const rest = `\n…他${names.length - i}人`;
    if ((out + '\n' + names[i]).length > 1024 - rest.length) return out + rest;
    out += (out ? '\n' : '') + names[i];
  }
  return out;
}

// closed: { text, kind: 'ended' | 'canceled' }（受付終了時のみ）
export function buildAttendanceMessage(eventId, att, closed = null) {
  const { yes, no, unanswered } = summarizeAttendance(att);
  const info = att.info;
  const embed = new EmbedBuilder()
    .setColor(closed ? CARD_COLORS[closed.kind] : CARD_COLORS.open)
    .setTitle(info ? info.name : att.eventName)
    .setDescription(info ? `🕘 ${info.time}〜 ｜ ${info.place} ｜ 👤 ${info.host}` : (att.header ?? '―'))
    .addFields(
      { name: `✅ 出席 (${yes.length})`, value: nameList(yes), inline: true },
      { name: `❌ 欠席 (${no.length})`, value: nameList(no), inline: true },
    )
    .setFooter({ text: closed ? closed.text : 'ボタンで出欠を登録（もう一度押すと取り消し）' });
  if (info?.url) embed.setURL(info.url);
  if (getMembers().length > 0) {
    embed.addFields({ name: `❔ 未回答 (${unanswered.length})`, value: nameList(unanswered.map(u => u.name)), inline: true });
  }
  return {
    content: '',
    embeds: [embed],
    components: attendanceButtons(eventId, !!closed),
    allowedMentions: { parse: [] },
  };
}

async function fetchAttendanceMessage(att) {
  const ch = await client.channels.fetch(att.channelId).catch(() => null);
  return ch ? await ch.messages.fetch(att.msgId).catch(() => null) : null;
}

export async function refreshAttendanceMessage(eventId, closed = null) {
  const att = db.data.attendance[eventId];
  if (!att?.msgId) return;
  if (closed) att.closed = closed; // 終了・キャンセル後に押されても表示が戻らないように
  const msg = await fetchAttendanceMessage(att);
  if (!msg) return;
  await msg.edit(buildAttendanceMessage(eventId, att, att.closed ?? null))
    .catch(e => console.error('出欠メッセージ更新失敗:', e.message));
}

async function getEventRoleById(guild, eventId) {
  const roleId = db.data.eventRoles[eventId];
  if (roleId) {
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (role) return role;
  }
  const event = await guild.scheduledEvents.fetch(eventId).catch(() => null);
  return event ? getOrCreateEventRole(guild, event) : null;
}

// 出欠を設定（status: 'yes' | 'no' | null）。ロールの付け外しとメッセージ更新も行う
export async function setAttendance(eventId, userId, status, displayName) {
  const att = db.data.attendance[eventId];
  if (!att) return;
  att.yes = att.yes.filter(id => id !== userId);
  att.no  = att.no.filter(id => id !== userId);
  if (status === 'yes') att.yes.push(userId);
  if (status === 'no')  att.no.push(userId);
  att.names ??= {};
  if (displayName) att.names[userId] = displayName;
  await db.write();

  const guild  = await client.guilds.fetch(GUILD_ID);
  const member = await guild.members.fetch(userId).catch(() => null);
  const role   = await getEventRoleById(guild, eventId);
  if (member && role) {
    if (status === 'yes') await member.roles.add(role).catch(() => {});
    else await member.roles.remove(role).catch(() => {});
  }
  console.log(`${status === 'yes' ? '✅' : status === 'no' ? '❌' : '↩️'} ${displayName ?? userId} → ${att.eventName}`);
  await refreshAttendanceMessage(eventId);
}

export async function handleAttendanceButton(interaction) {
  const [, status, eventId] = interaction.customId.split(':');
  const att = db.data.attendance[eventId];
  if (!att || att.closed) return interaction.reply({ content: '⚠️ このイベントの出欠受付は終了しています', flags: EPHEMERAL });
  await interaction.deferReply({ flags: EPHEMERAL });
  const uid = interaction.user.id;
  const current = att.yes.includes(uid) ? 'yes' : att.no.includes(uid) ? 'no' : null;
  const next = current === status ? null : status; // 同じボタンをもう一度押すと取り消し
  await setAttendance(eventId, uid, next, interaction.member?.displayName ?? interaction.user.username);
  const label = { yes: '✅ **出席**', no: '❌ **欠席**' };
  return interaction.editReply(next
    ? `${label[next]} で登録しました（「${att.eventName}」）`
    : `「${att.eventName}」の出欠を取り消しました`);
}

// 旧形式（リアクション式）のメッセージや、ボタン以外で付けられた✅/❌リアクション
export async function handleAttendanceReaction(reaction, user, add) {
  const eventId = db.data.reminderMsgMap?.[reaction.message.id];
  if (!eventId) return false;
  const emoji = reaction.emoji.name;
  if (emoji !== '✅' && emoji !== '❌') return false;
  const status = emoji === '✅' ? 'yes' : 'no';
  const att = db.data.attendance[eventId];
  const guild = await client.guilds.fetch(GUILD_ID);
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (att) {
    const current = att.yes.includes(user.id) ? 'yes' : att.no.includes(user.id) ? 'no' : null;
    if (add) await setAttendance(eventId, user.id, status, member?.displayName ?? user.username);
    else if (current === status) await setAttendance(eventId, user.id, null, member?.displayName ?? user.username);
    return true;
  }
  // 出欠データが無い古いメッセージはロールだけ付け外し（従来の動作）
  if (status !== 'yes' || !member) return true;
  const role = await getEventRoleById(guild, eventId);
  if (!role) return true;
  if (add) await member.roles.add(role).catch(() => {});
  else     await member.roles.remove(role).catch(() => {});
  return true;
}

async function postAttendanceMessage(guild, channel, e) {
  await getOrCreateEventRole(guild, e);
  const att = { eventName: e.name, info: buildInfo(e), yes: [], no: [], names: {}, channelId: channel.id, msgId: null };
  db.data.attendance[e.id] = att;
  const sent = await channel.send(buildAttendanceMessage(e.id, att));
  att.msgId = sent.id;
  db.data.lastReminderMsgIds.push(sent.id);
  db.data.reminderMsgMap[sent.id] = e.id;
  await db.write();
}

// ============================================================
// 朝リマインド
// ============================================================
export async function sendMorningSummary(withEveryone = true) {
  const guild   = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(ANNOUNCE_CHANNEL_ID);
  const events  = [...(await fetchTodaysEvents(guild)).values()]
    .filter(e => e.status === STATUS_SCHEDULED || e.status === STATUS_ACTIVE)
    .sort((a, b) => a.scheduledStartTimestamp - b.scheduledStartTimestamp);
  await stripAllEventRoles(guild);
  db.data.attendance = {};
  db.data.reminderNotices = {};
  db.data.lastReminderMsgIds = [];
  db.data.reminderMsgMap = {};
  db.data.lastMorningDate = jstDateKey(Date.now());
  await db.write();

  const mention = withEveryone ? '@everyone\n' : '';
  const allowedMentions = { parse: withEveryone ? ['everyone'] : [] };
  if (events.length === 0) {
    await channel.send({ content: `${mention}📭 本日のイベントはありません`, allowedMentions });
    return;
  }
  await channel.send({ content: `${mention}📅 本日のイベント一覧 (${events.length}件)`, allowedMentions });
  for (const e of events) await postAttendanceMessage(guild, channel, e);
}

// 朝リマインド後に今日のイベントが作られたら、出欠メッセージを追加で出す
async function postLateEvent(event) {
  if (db.data.lastMorningDate !== jstDateKey(Date.now())) return;
  if (jstDateKey(event.scheduledStartTimestamp) !== jstDateKey(Date.now())) return;
  if (db.data.attendance[event.id]) return;
  const guild   = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(ANNOUNCE_CHANNEL_ID);
  await channel.send({ content: '🆕 本日のイベントが追加されました', allowedMentions: { parse: [] } });
  await postAttendanceMessage(guild, channel, event);
}

// ============================================================
// 出欠とロールの突き合わせ
// ============================================================
// 起動時と /state-import 後に実行する。
// ・旧形式（✅❌リアクション）のメッセージは、リアクションを読み取ってボタン式に変換する
// ・「参加予定_」ロールを出席者と一致させる（停止中の付け外しを反映）
export async function reconcileAttendance() {
  const result = { added: 0, removed: 0, checked: 0, converted: 0 };
  const msgIds = db.data.lastReminderMsgIds ?? [];
  if (msgIds.length === 0) return result;
  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.members.fetch().catch(() => {}); // role.members を正しくするため

  for (const msgId of msgIds) {
    const eventId = db.data.reminderMsgMap?.[msgId];
    if (!eventId) continue;
    let att = db.data.attendance[eventId];

    if (!att) {
      // 旧形式 → ボタン式へ変換
      const event = await guild.scheduledEvents.fetch(eventId).catch(() => null);
      const channel = await guild.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
      const msg = channel ? await channel.messages.fetch(msgId).catch(() => null) : null;
      if (!event || !msg) continue;
      if (msg.components?.length > 0) {
        // すでにボタン式に変換済みなのに出欠データが無い（古いエクスポートを読み込んだ等）。
        // リアクションは消えているので、今のロール保持者を出席として復元し、ロールは触らない
        const roleId = db.data.eventRoles[eventId];
        const role = roleId ? await guild.roles.fetch(roleId).catch(() => null) : null;
        const yes = role ? [...role.members.keys()] : [];
        const names = Object.fromEntries(yes.map(id => [id, guild.members.cache.get(id)?.displayName ?? id]));
        db.data.attendance[eventId] = { eventName: event.name, info: buildInfo(event), yes, no: [], names, channelId: channel.id, msgId };
        await db.write();
        await msg.edit(buildAttendanceMessage(eventId, db.data.attendance[eventId])).catch(() => {});
        console.warn(`⚠️ 出欠データが無いため参加予定ロールから復元: "${event.name}"（出席 ${yes.length}名・欠席は不明）`);
        result.checked++;
        continue;
      }
      const readUsers = async (name) => {
        const r = msg.reactions.cache.find(x => x.emoji.name === name);
        if (!r) return [];
        const users = await r.users.fetch({ limit: 100 });
        return [...users.values()].filter(u => !u.bot).map(u => u.id);
      };
      let yes, no;
      try { yes = await readUsers('✅'); no = (await readUsers('❌')).filter(id => !yes.includes(id)); }
      catch (e) { console.error('リアクション読み取り失敗:', e.message); continue; }
      const names = {};
      for (const id of [...yes, ...no]) names[id] = guild.members.cache.get(id)?.displayName ?? id;
      att = { eventName: event.name, info: buildInfo(event), yes, no, names, channelId: channel.id, msgId };
      db.data.attendance[eventId] = att;
      await db.write();
      await msg.edit(buildAttendanceMessage(eventId, att))
        .catch(e => console.error('出欠メッセージ変換失敗:', e.message));
      await msg.reactions.removeAll().catch(() => {}); // 権限が無ければそのまま
      result.converted++;
    }

    const roleId = db.data.eventRoles[eventId];
    const role = roleId ? await guild.roles.fetch(roleId).catch(() => null) : null;
    if (!role) continue;
    const attending = new Set(att.yes);
    for (const uid of attending) {
      if (role.members.has(uid)) continue;
      const member = await guild.members.fetch(uid).catch(() => null);
      if (member && await member.roles.add(role).then(() => true).catch(() => false)) result.added++;
    }
    for (const member of [...role.members.values()]) {
      if (attending.has(member.id)) continue;
      if (await member.roles.remove(role).then(() => true).catch(() => false)) result.removed++;
    }
    result.checked++;
  }
  console.log(`🔁 出欠突き合わせ: ${result.checked}件確認 / 変換 ${result.converted} / 付与 ${result.added} / 解除 ${result.removed}`);
  return result;
}

// ============================================================
// イベントcron登録
// ============================================================
// イベント用cronのキーは `event:<イベントID>:<種類>`。
// 毎回「今あるべきcron」の集合を作り、それ以外の event: cron を止める。
// これでキャンセル・削除・時刻変更・同名イベントにも正しく追従する。
export const EVENT_JOB_PREFIX = 'event:';
const PAST_GRACE_MS = 60 * 1000;

// 同じイベントの古いリマインドを消して、最新の1通だけ残す
// （新しい通知を送ってから消すので、メンションの通知は届いたまま）
// db.data.reminderNotices[eventId] = { channelId, msgId }
async function replaceReminderNotice(eventId, newMsg) {
  const prev = db.data.reminderNotices[eventId];
  if (newMsg) db.data.reminderNotices[eventId] = { channelId: newMsg.channelId, msgId: newMsg.id };
  else delete db.data.reminderNotices[eventId];
  await db.write();
  if (!prev) return;
  const ch = await client.channels.fetch(prev.channelId).catch(() => null);
  const old = ch ? await ch.messages.fetch(prev.msgId).catch(() => null) : null;
  await old?.delete().catch(e => console.error('古いリマインドの削除失敗:', e.message));
}

export async function scheduleEventReminders() {
  const guild  = await client.guilds.fetch(GUILD_ID);
  const events = await fetchTodaysEvents(guild);
  const wanted = new Set();
  const now = Date.now();
  const offsets = db.data.reminderOffsets ?? [60, 15];

  // 過去の時刻は登録しない（日付指定のcronは翌年に発火してしまうため）
  const registerEventCron = (at, fn, desc) => {
    if (at.getTime() < now - PAST_GRACE_MS) return;
    wanted.add(desc);
    registerCron(cronExprAt(at), fn, desc);
  };

  for (const offset of offsets) {
    for (const e of events.values()) {
      if (e.status !== STATUS_SCHEDULED) continue;
      registerEventCron(new Date(e.scheduledStartTimestamp - offset * 60000), async () => {
        const g = await client.guilds.fetch(GUILD_ID);
        const current = (await g.scheduledEvents.fetch()).get(e.id);
        if (!current || current.status !== STATUS_SCHEDULED) return;
        const ch   = await g.channels.fetch(ANNOUNCE_CHANNEL_ID);
        const role = await getOrCreateEventRole(g, current);
        const sent = await ch.send({
          content: `${role}\n⏰ **${offset}分前リマインド** 「${current.name}」\n📍 チャンネル: ${eventPlace(current)}\n🔗 イベント:   <${eventUrl(current)}>`,
          allowedMentions: { roles: [role.id] },
        });
        await replaceReminderNotice(e.id, sent);
      }, `${EVENT_JOB_PREFIX}${e.id}:reminder:${offset}`);
    }
  }

  for (const e of events.values()) {
    if (e.status !== STATUS_SCHEDULED && e.status !== STATUS_ACTIVE) continue;
    const startTs = e.scheduledStartTimestamp;

    // 開始アナウンス
    registerEventCron(new Date(startTs), async () => {
      const g = await client.guilds.fetch(GUILD_ID);
      const current = (await g.scheduledEvents.fetch()).get(e.id);
      if (!current || current.status === STATUS_CANCELED || current.status === STATUS_COMPLETED) return;
      const ch = await g.channels.fetch(ANNOUNCE_CHANNEL_ID);
      await ch.send({ content: `@everyone\n🚀 **「${current.name}」が始まりました！**\n📍 会場: ${eventPlace(current)}\n🔗 イベント: <${eventUrl(current)}>`, allowedMentions: { parse: ['everyone'] } });
      // 開始したら直前のリマインドは不要なので消す
      await replaceReminderNotice(e.id, null);
    }, `${EVENT_JOB_PREFIX}${e.id}:start`);

    // 開始3分後：未参加チェック
    registerEventCron(new Date(startTs + 3 * 60000), async () => {
      const g = await client.guilds.fetch(GUILD_ID);
      const current = (await g.scheduledEvents.fetch()).get(e.id);
      if (!current) return;
      const ch   = await g.channels.fetch(ANNOUNCE_CHANNEL_ID);
      const role = await getOrCreateEventRole(g, current);
      const vcCh = current.channelId ? await g.channels.fetch(current.channelId).catch(() => null) : null;
      if (!vcCh) return;
      // role.members はキャッシュ依存なのでメンバーを取得しておく
      await g.members.fetch().catch(() => {});
      const vcIds     = new Set(vcCh.members?.keys() ?? []);
      const absentees = role.members.filter(m => !vcIds.has(m.id));
      if (absentees.size === 0) return;
      await ch.send({ content: `⚠️ 以下の出席予定者が参加していません:\n${absentees.map(m => `<@${m.id}>`).join('\n')}`, allowedMentions: { users: [...absentees.keys()] } });
    }, `${EVENT_JOB_PREFIX}${e.id}:absence`);

    // 開始5分後：まだ開始していなければ通知
    registerEventCron(new Date(startTs + 5 * 60000), async () => {
      const g = await client.guilds.fetch(GUILD_ID);
      const current = (await g.scheduledEvents.fetch()).get(e.id);
      // 予定(SCHEDULED)のままなら未開始。開催中・完了・キャンセルなら何もしない
      if (!current || current.status !== STATUS_SCHEDULED) return;
      const ch = await g.channels.fetch(ANNOUNCE_CHANNEL_ID);
      await ch.send({ content: `⚠️ 「${current.name}」はまだ開始されていません` });
    }, `${EVENT_JOB_PREFIX}${e.id}:not-started`);
  }

  // 不要になったイベントcron（キャンセル・削除・時刻変更前・過去分・削除したオフセット）を停止
  for (const desc of [...jobMap.keys()]) {
    if (desc.startsWith(EVENT_JOB_PREFIX) && !wanted.has(desc)) {
      stopJob(desc);
      console.log(`🗑️ cronを削除: ${desc}`);
    }
  }
}

// ============================================================
// VCセッション管理
// ============================================================
async function startVcSession(event) {
  if (!event.channelId) return;
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(event.channelId);
    if (!channel?.isVoiceBased()) return;
    // 参加者記録はVC接続の成否に関係なく先に開始する（記録はvoiceStateUpdateで行うため接続は必須ではない）
    const initialMembers = [...channel.members.keys()].filter(id => id !== client.user.id);
    db.data.activeVcSessions[event.id] = { channelId: event.channelId, participants: initialMembers };
    await db.write();
    console.log(`🎙️ VCセッション開始: "${event.name}" (初期: ${initialMembers.length}名)`);
    try {
      joinVoiceChannel({
        channelId: channel.id,
        guildId: GUILD_ID,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: true,
      });
    } catch (e) { console.error(`⚠️ VC接続失敗（参加者記録は継続）:`, e.message); }
  } catch (e) { console.error(`❌ VCセッション開始失敗:`, e.message); }
}

async function endVcSession(eventId, eventName) {
  try {
    const connection = getVoiceConnection(GUILD_ID);

    // 会議参加者にBotからGJを送信
    const session = db.data.activeVcSessions[eventId];
    if (session && session.participants?.length > 0) {
      const guild = await client.guilds.fetch(GUILD_ID);
      // 参加予定者ロールが設定されていればロール持ちのみ、なければ全員
      const roleId = db.data.eventRoles[eventId];
      let targets = session.participants;
      if (roleId) {
        await guild.members.fetch().catch(() => {});
        const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
        if (role) targets = session.participants.filter(id => role.members.has(id));
      }
      if (targets.length > 0) {
        try {
          const ch = await guild.channels.fetch(ANNOUNCE_CHANNEL_ID);
          const mentions = targets.map(id => `<@${id}>`).join('');
          await ch.send({ content: `${mentions}\n🔥 お前等、ナイス会議参加だったぜ！！俺からお前等全員にGJを送ってやる！！`, allowedMentions: { users: targets } });
          for (const uid of targets) {
            const member = await guild.members.fetch(uid).catch(() => null);
            if (!member) continue;
            // BotからのGJ（GJPのみ付与、GSPなし）
            getGjPoints(db, uid).gjp++;
            ensureMonthlyCounter(db, uid).monthlyGjp++;
            db.data.gjData.history.push({
              from: client.user.id, to: uid, reason: 'ナイス会議参加!!!',
              anonymous: false, channelId: ANNOUNCE_CHANNEL_ID, timestamp: new Date().toISOString(),
            });
            await checkAchievements(db, client, GUILD_ID, uid, 'received', ch);
          }
          await db.write();
        } catch (e) { console.error('会議GJ送信失敗:', e.message); }
      }
    }

    if (connection) connection.destroy();
    await writeParticipantsToCalendar(eventId, eventName);
    delete db.data.activeVcSessions[eventId];
    await db.write();
    console.log(`🎙️ VCセッション終了: "${eventName}"`);
  } catch (e) { console.error(`❌ VCセッション終了失敗:`, e.message); }
}

// ============================================================
// Discordイベントの監視
// ============================================================
async function closeAttendance(eventId, text, kind) {
  if (!db.data.attendance[eventId]) return;
  await refreshAttendanceMessage(eventId, { text, kind });
}

export function registerEventHandlers() {
  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    if (newState.guild.id !== GUILD_ID) return;
    const userId = newState.id;
    if (userId === client.user.id) return;
    if (!newState.channelId || newState.channelId === oldState.channelId) return;
    for (const session of Object.values(db.data.activeVcSessions)) {
      if (session.channelId !== newState.channelId) continue;
      if ((db.data.vcExcludeUsers ?? []).includes(userId)) continue;
      if (!session.participants.includes(userId)) {
        session.participants.push(userId);
        await db.write();
        console.log(`🎙️ VC参加記録: ${userId}`);
      }
    }
  });

  client.on(Events.GuildScheduledEventUpdate, async (oldEvent, newEvent) => {
    try {
      if (newEvent.guildId !== GUILD_ID) return;
      const guild = await client.guilds.fetch(GUILD_ID);

      if (newEvent.status === STATUS_ACTIVE && oldEvent?.status !== STATUS_ACTIVE) {
        console.log(`▶ イベント開始: "${newEvent.name}"`);
        await startVcSession(newEvent);
      } else if (newEvent.status === STATUS_COMPLETED && oldEvent?.status !== STATUS_COMPLETED) {
        console.log(`⏹ イベント完了: "${newEvent.name}"`);
        await endVcSession(newEvent.id, newEvent.name);
        await deleteEventRole(guild, newEvent.id);
        await closeAttendance(newEvent.id, '🏁 このイベントは終了しました', 'ended');
      } else if (newEvent.status === STATUS_CANCELED) {
        await deleteEventRole(guild, newEvent.id);
        await deleteCalendarEvent(newEvent.id, newEvent.name);
        delete db.data.activeVcSessions[newEvent.id];
        await db.write();
        await closeAttendance(newEvent.id, '🚫 このイベントはキャンセルされました', 'canceled');
      }
      // 時刻・名前などの変更も含め、cronを即座に更新
      await scheduleEventReminders();
    } catch (e) { console.error('イベント更新処理エラー:', e.message); }
  });

  client.on(Events.GuildScheduledEventCreate, async event => {
    try {
      if (event.guildId !== GUILD_ID) return;
      await scheduleEventReminders();
      await postLateEvent(event);
    } catch (e) { console.error('イベント作成処理エラー:', e.message); }
  });

  client.on(Events.GuildScheduledEventDelete, async event => {
    try {
      if (event.guildId !== GUILD_ID) return;
      const guild = await client.guilds.fetch(GUILD_ID);
      await deleteEventRole(guild, event.id);
      await deleteCalendarEvent(event.id, event.name);
      delete db.data.activeVcSessions[event.id];
      await db.write();
      await closeAttendance(event.id, '🚫 このイベントは削除されました', 'canceled');
      await scheduleEventReminders();
    } catch (e) { console.error('イベント削除処理エラー:', e.message); }
  });
}
