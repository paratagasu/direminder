// 共通ユーティリティ
export const EPHEMERAL = 64;

// 2000文字を超えるメッセージを分割して返信（defer済みであること）
export async function replyLong(interaction, text, { ephemeral = false } = {}) {
  const chunks = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf.length + line.length + 1 > 1900) { chunks.push(buf); buf = ''; }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf) chunks.push(buf);
  // 一覧表示で誰かに通知が飛ばないよう、メンションは常に無効にする
  const allowedMentions = { parse: [] };
  await interaction.editReply({ content: chunks[0] || '（なし）', allowedMentions });
  for (const c of chunks.slice(1)) await interaction.followUp({ content: c, allowedMentions, ...(ephemeral && { flags: EPHEMERAL }) });
}

export function isAdmin(interaction) {
  return interaction.member?.permissions?.has?.('Administrator') ?? false;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
