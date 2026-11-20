// チャンネルのメッセージを範囲指定で JSONL に書き出す（/export_chat）
// 会議の書き起こしを、チャットの正しい文章と書いた人の名前に置き換えるために使う。
//
// 守ること：書き出した本文は Bot のログや外部に出さない（ログには件数と所要時間だけ）。
// ファイルはメモリ上で作って DM に添付するだけで、ディスクには書かず、Bot 側にも残さない。
import { MessageType } from 'discord.js';
import { JST_OFFSET_MS } from '../time.js';

export const MAX_MESSAGES = 10_000;
// DM の添付は 10MB まで。余裕を見て 8MB ごとに分ける
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

// ============================================================
// 入力（メッセージリンク または ID）の読み取り
// ============================================================
// https://discord.com/channels/<サーバー>/<チャンネル>/<メッセージ>（ptb・canary・discordapp.com も可）
const LINK_RE = /^https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d{5,25}|@me)\/(\d{5,25})\/(\d{5,25})\/?$/;
const ID_RE = /^\d{5,25}$/;

// 戻り値: { guildId, channelId, messageId }（ID だけのときは guildId・channelId が null）／読めなければ null
export function parseMessageRef(text) {
  const s = (text ?? '').trim().replace(/^<|>$/g, '');
  const m = LINK_RE.exec(s);
  if (m) return { guildId: m[1], channelId: m[2], messageId: m[3] };
  if (ID_RE.test(s)) return { guildId: null, channelId: null, messageId: s };
  return null;
}

const cmpId = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

// ============================================================
// 取得
// ============================================================
// lo〜hi（両端を含む・hi が null なら最新まで）のメッセージを古い順に集める。
// discord.js の履歴取得（100件ずつ）を使うので、レート制限はライブラリが守ってくれる。
// onProgress(取得済み件数) は数百件ごとに呼ぶ
export async function collectMessages(channel, loId, hiId, { onProgress, max = MAX_MESSAGES } = {}) {
  const first = await channel.messages.fetch(loId);
  const messages = [];
  let skippedSystem = 0;
  let truncated = false;

  const take = (msg) => {
    if (isSystemMessage(msg)) { skippedSystem++; return true; }
    if (messages.length >= max) { truncated = true; return false; }
    messages.push(msg);
    return true;
  };

  take(first);
  let cursor = loId;
  let batches = 0;
  while (!truncated && (hiId === null || cmpId(cursor, hiId) < 0)) {
    const batch = await channel.messages.fetch({ after: cursor, limit: 100, cache: false });
    if (batch.size === 0) break;
    const sorted = [...batch.values()].sort((a, b) => cmpId(a.id, b.id));
    for (const msg of sorted) {
      if (hiId !== null && cmpId(msg.id, hiId) > 0) break;
      if (!take(msg)) break;
    }
    cursor = sorted[sorted.length - 1].id;
    if (batch.size < 100) break;
    if (++batches % 5 === 0) await onProgress?.(messages.length);
  }
  return { messages, skippedSystem, truncated };
}

// 参加・ピン留め・ブースト等のシステムメッセージは書き出さない（返信やコマンドの応答は書き出す）
const NORMAL_TYPES = new Set([MessageType.Default, MessageType.Reply, MessageType.ChatInputCommand, MessageType.ContextMenuCommand]);
export function isSystemMessage(msg) {
  return !NORMAL_TYPES.has(msg.type);
}

// ============================================================
// 書き出し（JSONL）
// ============================================================
// 日本時間（+09:00）・ミリ秒つきの ISO 8601
export function toJstIso(ts) {
  if (ts == null) return null;
  return new Date(new Date(ts).getTime() + JST_OFFSET_MS).toISOString().replace('Z', '+09:00');
}

export function messageRecord(msg, guild) {
  const member = msg.member ?? guild?.members?.cache?.get(msg.author.id);
  return {
    type: 'message',
    id: msg.id,
    created_at: toJstIso(msg.createdTimestamp),
    author_id: msg.author.id,
    author_name: member?.displayName ?? msg.author.globalName ?? msg.author.username,
    is_bot: !!msg.author.bot,
    content: msg.content ?? '',
    clean_content: msg.cleanContent ?? msg.content ?? '',
    edited_at: toJstIso(msg.editedTimestamp),
    attachments: msg.attachments?.size ?? 0,
    embeds: msg.embeds?.length ?? 0,
    reply_to: msg.type === MessageType.Reply ? (msg.reference?.messageId ?? null) : null,
  };
}

// 1行目がメタ情報の JSONL を作る。上限を超える場合は分割し、各ファイルの1行目にメタ情報を入れる
// 戻り値: [{ name, buffer, count }]
export function buildJsonlFiles({ guildId, channel, startId, endId, records, skippedSystem, exportedAt, maxBytes = MAX_FILE_BYTES }) {
  const lines = records.map(r => JSON.stringify(r));
  const meta = (part, parts, count) => JSON.stringify({
    type: 'meta',
    guild_id: guildId,
    channel_id: channel.id,
    channel_name: channel.name,
    start_id: startId,
    end_id: endId,
    exported_at: exportedAt,
    count,
    skipped_system: skippedSystem,
    ...(parts > 1 && { part, parts, total_count: records.length }),
  });

  // まず分け方を決める（メタ行の分の余裕を見て）
  const groups = [];
  let cur = [], size = 0;
  const budget = maxBytes - 1024;
  for (const line of lines) {
    const bytes = Buffer.byteLength(line, 'utf-8') + 1;
    if (cur.length > 0 && size + bytes > budget) { groups.push(cur); cur = []; size = 0; }
    cur.push(line); size += bytes;
  }
  groups.push(cur);

  return groups.map((group, i) => {
    const first = records.length ? JSON.parse(group[0] ?? '{}').id ?? startId : startId;
    const last = records.length ? JSON.parse(group[group.length - 1] ?? '{}').id ?? endId : endId;
    const count = groups.length > 1 ? group.length : records.length;
    const text = [meta(i + 1, groups.length, count), ...group].join('\n') + '\n';
    return { name: `chat_${channel.id}_${first}_${last}.jsonl`, buffer: Buffer.from(text, 'utf-8'), count };
  });
}
