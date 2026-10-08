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
  await interaction.editReply(chunks[0] || '（なし）');
  for (const c of chunks.slice(1)) await interaction.followUp({ content: c, ...(ephemeral && { flags: EPHEMERAL }) });
}

export function isAdmin(interaction) {
  return interaction.member?.permissions?.has?.('Administrator') ?? false;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
