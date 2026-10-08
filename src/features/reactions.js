// リアクションの振り分け（GJ・出欠・カレンダー予定削除）
import { Events } from 'discord.js';
import { client } from '../client.js';
import { db } from '../db.js';
import { GUILD_ID } from '../config.js';
import { calendar, calendarEnabled } from '../calendar.js';
import { GOOD_JOB_EMOJI_ID, GOOD_JOB_EMOJI_NAME, sendGoodJob } from '../gj.js';
import { handleAttendanceReaction } from './events.js';

async function handleGoodJobReaction(reaction, user) {
  const fromId = user.id;
  const toId   = reaction.message.author?.id;
  if (!toId || fromId === toId || reaction.message.author?.bot) return;
  const guild      = await client.guilds.fetch(GUILD_ID);
  const fromMember = await guild.members.fetch(fromId).catch(() => null);
  const toMember   = await guild.members.fetch(toId).catch(() => null);
  if (!fromMember || !toMember) return;
  // partialの場合はfetchして確実にチャンネルを取得
  const ch = reaction.message.channel.partial
    ? await reaction.message.channel.fetch().catch(() => reaction.message.channel)
    : reaction.message.channel;
  console.log(`👍 GJリアクション: ${fromMember.displayName} → ${toMember.displayName}`);
  const result = await sendGoodJob(db, client, GUILD_ID, {
    fromId, fromName: fromMember.displayName,
    toId,   toName:   toMember.displayName,
    reason: null, anonymous: false, channel: ch,
  });
  if (!result.success) {
    // 通常メッセージには「自分だけに表示」が使えないので、少し後に消す
    const notice = await ch.send({ content: `<@${fromId}> ${result.reason}`, allowedMentions: { users: [fromId] } }).catch(() => null);
    if (notice) setTimeout(() => notice.delete().catch(() => {}), 10000);
  }
}

// /cal-delete の数字リアクション
async function handleCalendarDeleteReaction(reaction, user) {
  const session = db.data.pendingDeleteSessions?.[user.id];
  if (!session || reaction.message.id !== session.msgId) return;
  if (user.id !== session.requesterId) return; // 本人以外は無視
  const emojiName = reaction.emoji.name;

  if (emojiName === '❌') {
    delete db.data.pendingDeleteSessions[user.id];
    await db.write();
    await reaction.message.reply('🚫 削除をキャンセルしました');
    return;
  }

  const numberEmojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
  const idx = numberEmojis.indexOf(emojiName);
  if (idx === -1 || idx >= session.events.length) return;

  const targetEvent = session.events[idx];
  try {
    if (!calendarEnabled) throw new Error('Calendar未設定');
    await calendar.events.delete({ calendarId: session.calendarId, eventId: targetEvent.id });
    delete db.data.pendingDeleteSessions[user.id];
    await db.write();
    await reaction.message.reply(`✅ 「${targetEvent.summary}」を削除しました`);
    console.log(`🗑️ 予定削除: "${targetEvent.summary}" by ${user.username}`);
  } catch (e) {
    await reaction.message.reply(`❌ 削除に失敗しました: ${e.message}`);
  }
}

async function handleReaction(reaction, user, add) {
  // partial（キャッシュにない古いメッセージ）の場合は取得し直す
  if (reaction.partial) await reaction.fetch().catch(() => {});
  if (reaction.message.partial) await reaction.message.fetch().catch(() => {});
  if (user.partial) user = await user.fetch().catch(() => user);
  if (user.bot) return;

  if (reaction.emoji.id === GOOD_JOB_EMOJI_ID || reaction.emoji.name === GOOD_JOB_EMOJI_NAME) {
    if (add) await handleGoodJobReaction(reaction, user).catch(e => console.error('GJリアクション処理失敗:', e.message));
    return;
  }
  if (await handleAttendanceReaction(reaction, user, add)) return;
  if (add) await handleCalendarDeleteReaction(reaction, user);
}

export function registerReactionHandlers() {
  client.on(Events.MessageReactionAdd,    (r, u) => handleReaction(r, u, true).catch(e => console.error('リアクション処理エラー:', e.message)));
  client.on(Events.MessageReactionRemove, (r, u) => handleReaction(r, u, false).catch(e => console.error('リアクション処理エラー:', e.message)));
}
