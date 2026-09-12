// gj.js - グッジョブシステム

export const GOOD_JOB_EMOJI_ID   = '1547921508385554482';
export const GOOD_JOB_EMOJI_NAME  = 'GOOD_JOB';
export const GJ_ANNOUNCE_CHANNEL  = '1357515614498848909';

// ============================================================
// ヘルパー
// ============================================================
export function todayJst() {
  return new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

export function initGjData(db) {
  db.data.gjData ??= {};
  db.data.gjData.points          ??= {};
  db.data.gjData.history         ??= [];
  db.data.gjData.achievements    ??= {};
  db.data.gjData.dailySent       ??= {};
  db.data.gjData.gjChain         ??= null;
  db.data.gjData.monthlyCounters ??= {};
}

export function getGjPoints(db, userId) {
  db.data.gjData.points[userId] ??= { gjp: 0, gsp: 0 };
  return db.data.gjData.points[userId];
}

export function getDailySentCount(db, fromId, toId) {
  const key = `${fromId}:${toId}:${todayJst()}`;
  return db.data.gjData.dailySent[key] ?? 0;
}

function incrementDailySent(db, fromId, toId) {
  const key = `${fromId}:${toId}:${todayJst()}`;
  db.data.gjData.dailySent[key] = (db.data.gjData.dailySent[key] ?? 0) + 1;
}

// ============================================================
// 実績チェック
// ============================================================
export async function checkAchievements(db, client, GUILD_ID, userId, type, channel) {
  const history = db.data.gjData.history;
  db.data.gjData.achievements[userId] ??= { received: [], sent: [] };
  const ach  = db.data.gjData.achievements[userId];
  const msgs = [];

  if (type === 'received') {
    const received = history.filter(h => h.to === userId);
    const count    = received.length;
    const senders  = new Set(received.map(h => h.from)).size;

    // 7日連続受信チェック
    const days = new Set(received.map(h => new Date(h.timestamp).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' })));
    let streak = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      if (days.has(d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' }))) streak++;
      else break;
    }

    if (count === 1   && !ach.received.includes('first'))   { ach.received.push('first');   msgs.push(`🌱 **初GJ達成！** <@${userId}> が初めてグッジョブを受け取りました！`); }
    if (count === 10  && !ach.received.includes('10'))      { ach.received.push('10');      msgs.push(`👍 **GJ 10回達成！** <@${userId}> がグッジョブを10回受け取りました！`); }
    if (count === 100 && !ach.received.includes('100'))     { ach.received.push('100');     msgs.push(`🔥 **GJ 100回達成！** <@${userId}> がグッジョブを100回受け取りました！！`); }
    if (count === 500 && !ach.received.includes('500'))     { ach.received.push('500');     msgs.push(`👑 **GJ 500回達成！** <@${userId}> がグッジョブを500回受け取りました！！！`); }
    if (senders >= 10 && !ach.received.includes('10src'))  { ach.received.push('10src');   msgs.push(`💎 **多方面から支持！** <@${userId}> が10人以上からグッジョブを受け取りました！`); }
    if (streak >= 7   && !ach.received.includes('7streak')){ ach.received.push('7streak'); msgs.push(`🌟 **7日連続GJ！** <@${userId}> が7日連続でグッジョブを受け取りました！`); }
  }

  if (type === 'sent') {
    const sent    = history.filter(h => h.from === userId && !h.anonymous);
    const count   = sent.length;
    const targets = new Set(sent.map(h => h.to)).size;
    const todaySent = sent.filter(h =>
      new Date(h.timestamp).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' }) === todayJst()
    ).length;

    if (count === 1    && !ach.sent.includes('first'))   { ach.sent.push('first');   msgs.push(`🤝 **初GJ送信！** <@${userId}> が初めてグッジョブを送りました！`); }
    if (targets === 10 && !ach.sent.includes('10tgt'))   { ach.sent.push('10tgt');   msgs.push(`❤️ **10人にGJ！** <@${userId}> が10人にグッジョブを送りました！`); }
    if (targets >= 20  && !ach.sent.includes('20tgt'))   { ach.sent.push('20tgt');   msgs.push(`🌎 **20人以上にGJ！** <@${userId}> が20人以上にグッジョブを送りました！`); }
    if (todaySent >= 10 && !ach.sent.includes('10day'))  { ach.sent.push('10day');   msgs.push(`🫂 **1日10GJ！** <@${userId}> が1日に10回グッジョブを送りました！`); }
  }

  db.data.gjData.achievements[userId] = ach;
  for (const msg of msgs) {
    try { await channel.send({ content: msg, allowedMentions: { users: [userId] } }); } catch (e) { console.error('実績通知失敗:', e.message); }
  }
}

// ============================================================
// コンボチェーン
// ============================================================
export async function processGjChain(db, client, GUILD_ID, fromId, toId, channelId) {
  const now   = Date.now();
  const chain = db.data.gjData.gjChain;

  const getNames = async (ids) => {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    return Promise.all(ids.map(async id => {
      const m = await guild?.members.fetch(id).catch(() => null);
      return m?.displayName ?? id;
    }));
  };

  // 1時間以上経過 → 爆裂
  if (chain && now - chain.lastAt > 60 * 60 * 1000) {
    try {
      const ch = await client.channels.fetch(chain.lastChannelId);
      await ch.send(`💥 コンボチェーンが **${chain.chain.length}Hit** で爆裂しました！Beat.`);
    } catch (e) {}
    db.data.gjData.gjChain = null;
  }

  const cur = db.data.gjData.gjChain;

  if (!cur) {
    db.data.gjData.gjChain = { chain: [fromId, toId], lastAt: now, lastChannelId: channelId };
  } else {
    const last = cur.chain[cur.chain.length - 1];
    if (last === fromId) {
      cur.chain.push(toId);
      cur.lastAt = now;
      cur.lastChannelId = channelId;
      const hits = cur.chain.length;
      try {
        const ch    = await client.channels.fetch(channelId);
        const names = await getNames(cur.chain);
        if (hits === 2) {
          await ch.send(`🔥 **GJ CHAIN ×${hits}**\n${names.join(' → ')}\n🔥 サーバー内にグッジョブの連鎖が発生しました！`);
        } else {
          await ch.send(`🔥 **${hits}Hit!**\n${names.join(' → ')}`);
        }
      } catch (e) { console.error('チェーン通知失敗:', e.message); }
    } else {
      // チェーン途切れ → 爆裂して新チェーン開始
      try {
        const ch = await client.channels.fetch(cur.lastChannelId);
        await ch.send(`💥 コンボチェーンが **${cur.chain.length}Hit** で爆裂しました！Beat.`);
      } catch (e) {}
      db.data.gjData.gjChain = { chain: [fromId, toId], lastAt: now, lastChannelId: channelId };
    }
  }
}

// ============================================================
// GJ COUNTER!!!
// ============================================================
export async function checkGjCounter(db, fromId, toId, channel) {
  const now = Date.now();
  const received = db.data.gjData.history.filter(h =>
    h.to === fromId && h.from === toId && !h.anonymous &&
    now - new Date(h.timestamp).getTime() < 24 * 60 * 60 * 1000
  );
  if (received.length > 0) {
    try { await channel.send(`# 🔥GJ COUNTER!!!`); } catch (e) {}
    [fromId, toId].forEach(id => {
      db.data.gjData.monthlyCounters[id] ??= { gjCounterCount: 0, monthlyGjp: 0, monthlyGsp: 0, uniqueSenders: [] };
      db.data.gjData.monthlyCounters[id].gjCounterCount++;
    });
  }
}

// ============================================================
// GJ送信メイン処理
// ============================================================
export async function sendGoodJob(db, client, GUILD_ID, { fromId, fromName, toId, toName, reason, anonymous, channel }) {
  if (getDailySentCount(db, fromId, toId) >= 3) {
    return { success: false, reason: `❌ ${toName} への本日のGJは上限（3回）に達しています` };
  }
  if (fromId === toId) {
    return { success: false, reason: '❌ 自分自身にGJは送れません' };
  }

  const entry = { from: fromId, to: toId, reason: reason ?? '', anonymous, channelId: channel.id, timestamp: new Date().toISOString() };
  db.data.gjData.history.push(entry);

  // ポイント付与
  const toPoints = getGjPoints(db, toId);
  toPoints.gjp++;
  db.data.gjData.monthlyCounters[toId] ??= { gjCounterCount: 0, monthlyGjp: 0, monthlyGsp: 0, uniqueSenders: [] };
  db.data.gjData.monthlyCounters[toId].monthlyGjp++;
  if (!db.data.gjData.monthlyCounters[toId].uniqueSenders.includes(fromId)) {
    db.data.gjData.monthlyCounters[toId].uniqueSenders.push(fromId);
  }

  if (!anonymous) {
    const fromPoints = getGjPoints(db, fromId);
    fromPoints.gsp++;
    db.data.gjData.monthlyCounters[fromId] ??= { gjCounterCount: 0, monthlyGjp: 0, monthlyGsp: 0, uniqueSenders: [] };
    db.data.gjData.monthlyCounters[fromId].monthlyGsp++;
  }

  incrementDailySent(db, fromId, toId);
  await db.write();

  // アナウンス
  const senderDisplay = anonymous ? '誰か' : fromName;
  let msg = `🔥 **${senderDisplay}** が **${toName}** にグッジョブを送信しました！！`;
  if (reason) msg += `\n> ${reason}`;
  msg += anonymous
    ? `\n（+1 GJP → ${toName}、GSPは匿名のため付与なし）`
    : `\n（+1 GJP → ${toName}、+1 GSP → ${fromName}）`;

  await channel.send({ content: msg, allowedMentions: { users: [toId] } });

  // 実績チェック
  await checkAchievements(db, client, GUILD_ID, toId, 'received', channel);
  if (!anonymous) await checkAchievements(db, client, GUILD_ID, fromId, 'sent', channel);

  // コンボ・カウンター（非匿名のみ）
  if (!anonymous) {
    await processGjChain(db, client, GUILD_ID, fromId, toId, channel.id);
    await checkGjCounter(db, fromId, toId, channel);
  }

  return { success: true };
}

// ============================================================
// 月間表彰
// ============================================================
export async function sendMonthlyAwards(db, client, GUILD_ID) {
  const mc      = db.data.gjData.monthlyCounters ?? {};
  const history = db.data.gjData.history ?? [];
  const now     = new Date();
  const monthStr = `${now.getFullYear()}年${now.getMonth() + 1}月`;

  try {
    const ch    = await client.channels.fetch(GJ_ANNOUNCE_CHANNEL);
    const guild = await client.guilds.fetch(GUILD_ID);
    const getName = async id => (await guild.members.fetch(id).catch(() => null))?.displayName ?? id;

    const entries = Object.entries(mc);
    const topGjp     = entries.sort((a,b) => b[1].monthlyGjp - a[1].monthlyGjp)[0];
    const topGsp     = entries.sort((a,b) => b[1].monthlyGsp - a[1].monthlyGsp)[0];
    const topSenders = entries.sort((a,b) => (b[1].uniqueSenders?.length??0) - (a[1].uniqueSenders?.length??0))[0];
    const topCounter = entries.sort((a,b) => b[1].gjCounterCount - a[1].gjCounterCount)[0];

    const [n1,n2,n3,n4] = await Promise.all([
      topGjp     ? getName(topGjp[0])     : '（なし）',
      topGsp     ? getName(topGsp[0])     : '（なし）',
      topSenders ? getName(topSenders[0]) : '（なし）',
      topCounter ? getName(topCounter[0]) : '（なし）',
    ]);

    // 研究結果
    const monthHistory = history.filter(h => {
      const d = new Date(h.timestamp);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    });
    const withThanks = monthHistory.filter(h => h.reason?.includes('ありがとう')).length;
    const reasonPct  = monthHistory.length > 0 ? Math.round(withThanks / monthHistory.length * 100) : 0;
    const hours      = monthHistory.map(h => new Date(h.timestamp).getHours());
    const topHour    = hours.length > 0 ? hours.sort((a,b) => hours.filter(x=>x===b).length - hours.filter(x=>x===a).length)[0] : '-';
    const weekdays   = monthHistory.map(h => new Date(h.timestamp).toLocaleDateString('ja-JP', { weekday: 'long', timeZone: 'Asia/Tokyo' }));
    const topDay     = weekdays.length > 0 ? weekdays.sort((a,b) => weekdays.filter(x=>x===b).length - weekdays.filter(x=>x===a).length)[0] : '-';
    const reasons    = monthHistory.filter(h => h.reason).map(h => h.reason);
    const longestLen = reasons.length > 0 ? Math.max(...reasons.map(r => r.length)) : 0;
    const pairMap    = {};
    monthHistory.filter(h => !h.anonymous).forEach(h => {
      const key = [h.from, h.to].sort().join(':');
      pairMap[key] = (pairMap[key] ?? 0) + 1;
    });
    const topPairKey = Object.entries(pairMap).sort((a,b) => b[1]-a[1])[0]?.[0];
    let topPairStr = '（なし）';
    if (topPairKey) {
      const [id1, id2] = topPairKey.split(':');
      const [pn1, pn2] = await Promise.all([getName(id1), getName(id2)]);
      topPairStr = `${pn1} ↔ ${pn2}`;
    }

    await ch.send([
      '━━━━━━━━━━━━━━',
      '       🏆 GJ AWARDS',
      `      ${monthStr}`,
      '━━━━━━━━━━━━━━',
      '',
      `👑 最多GJ\n${n1}　　${topGjp?.[1]?.monthlyGjp ?? 0} GJ`,
      '',
      `🤝 最多GJ送信\n${n2}　　${topGsp?.[1]?.monthlyGsp ?? 0} GJ`,
      '',
      `🌟 多方面から支持された人\n${n3}　　${topSenders?.[1]?.uniqueSenders?.length ?? 0}人からGJ`,
      '',
      `🔥 GJカウンター最多\n${n4}　　×${topCounter?.[1]?.gjCounterCount ?? 0}`,
      '',
      '━━━━━━━━━━━━━━',
    ].join('\n'));

    await ch.send([
      `🧪 今月のGJ研究結果`,
      `「ありがとう」を含むGJ：${withThanks}件 (${reasonPct}%)`,
      `最もGJされた時間：${topHour !== '-' ? topHour + ':00' : '-'}`,
      `最もGJを送った曜日：${topDay}`,
      `一番GJを送り合っている2人：${topPairStr}`,
      `最長GJ理由：${longestLen}文字`,
    ].join('\n'));

    db.data.gjData.monthlyCounters = {};
    await db.write();
    console.log('🏆 月間表彰送信完了');
  } catch (e) { console.error('月間表彰失敗:', e.message); }
}
