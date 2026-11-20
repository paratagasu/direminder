// /export_chat … チャンネルのメッセージを範囲指定で JSONL に書き出し、実行した人の DM に送る
import { SlashCommandBuilder, AttachmentBuilder, PermissionFlagsBits } from 'discord.js';
import { client } from '../client.js';
import { GUILD_ID, EXPORT_CHAT_ROLE_IDS } from '../config.js';
import { isAdmin, EPHEMERAL } from '../util.js';
import {
  parseMessageRef, collectMessages, messageRecord, buildJsonlFiles, toJstIso, MAX_MESSAGES,
} from '../features/exportChat.js';

const allowedRoleIds = (EXPORT_CHAT_ROLE_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const running = new Set(); // 同じ人が同時に何本も走らせないように

export function canExport(interaction) {
  if (isAdmin(interaction)) return true;
  const roles = interaction.member?.roles;
  const has = id => (roles?.cache ? roles.cache.has(id) : Array.isArray(roles) && roles.includes(id));
  return allowedRoleIds.some(has);
}

const VIEW_HISTORY = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('export_chat').setDescription('チャンネルのメッセージを範囲指定でファイルに書き出してDMに送る（管理者専用）')
      .addStringOption(o => o.setName('start').setDescription('最初のメッセージのリンクまたはID').setRequired(true))
      .addStringOption(o => o.setName('end').setDescription('最後のメッセージのリンクまたはID（省略で最新まで）')),
    async execute(interaction) {
      if (!canExport(interaction)) {
        return interaction.reply({ content: '⛔ このコマンドは管理者（または許可されたロール）だけが使えます', flags: EPHEMERAL });
      }
      const startRef = parseMessageRef(interaction.options.getString('start'));
      const endText  = interaction.options.getString('end');
      const endRef   = endText ? parseMessageRef(endText) : null;
      if (!startRef || (endText && !endRef)) {
        return interaction.reply({ content: '❌ start / end には、メッセージのリンク（右クリック →「リンクをコピー」）かメッセージIDを入れてください', flags: EPHEMERAL });
      }
      for (const ref of [startRef, endRef]) {
        if (ref?.guildId && ref.guildId !== GUILD_ID) {
          return interaction.reply({ content: '❌ このサーバーのメッセージのリンクを指定してください', flags: EPHEMERAL });
        }
      }
      // チャンネルはリンクから判定。ID だけのときは、もう一方のリンクのチャンネル → コマンドを実行したチャンネル
      const startCh = startRef.channelId ?? endRef?.channelId ?? interaction.channelId;
      const endCh   = endRef ? (endRef.channelId ?? startCh) : startCh;
      if (startCh !== endCh) {
        return interaction.reply({ content: '❌ start と end が別のチャンネルのメッセージです。同じチャンネルのメッセージを指定してください', flags: EPHEMERAL });
      }
      if (running.has(interaction.user.id)) {
        return interaction.reply({ content: '⏳ 前の書き出しがまだ終わっていません。終わってからもう一度実行してください', flags: EPHEMERAL });
      }

      await interaction.deferReply({ flags: EPHEMERAL });
      running.add(interaction.user.id);
      const startedAt = Date.now();
      try {
        const channel = await client.channels.fetch(startCh).catch(() => null);
        if (!channel || channel.guildId !== GUILD_ID || !channel.messages) {
          return interaction.editReply('❌ チャンネルが見つかりません（ボイスチャンネルのテキストチャット・テキストチャンネル・スレッドに対応しています）');
        }
        // 実行した人がそのチャンネルを読めること（見えないチャンネルの中身を書き出せないように）と、Botが読めること
        const guild = await client.guilds.fetch(GUILD_ID);
        const me = guild.members.me ?? await guild.members.fetchMe();
        if (!channel.permissionsFor(interaction.member ?? interaction.user.id)?.has(VIEW_HISTORY)) {
          return interaction.editReply('⛔ あなたはこのチャンネルのメッセージ履歴を閲覧できません');
        }
        if (!channel.permissionsFor(me)?.has(VIEW_HISTORY)) {
          return interaction.editReply('❌ Botにこのチャンネルの「チャンネルを見る」「メッセージ履歴を読む」権限がありません');
        }

        // 順番をそろえる（逆に指定されても OK）
        let lo = startRef.messageId, hi = endRef?.messageId ?? null;
        if (hi && BigInt(hi) < BigInt(lo)) [lo, hi] = [hi, lo];
        for (const id of [lo, hi].filter(Boolean)) {
          const ok = await channel.messages.fetch(id).then(() => true).catch(() => false);
          if (!ok) return interaction.editReply(`❌ メッセージ（ID: ${id}）が、このチャンネルに見つかりません`);
        }

        await interaction.editReply('⏳ メッセージを取得しています…');
        await guild.members.fetch().catch(() => {}); // 表示名・メンションの名前のため
        const { messages, skippedSystem, truncated } = await collectMessages(channel, lo, hi, {
          onProgress: n => interaction.editReply(`⏳ メッセージを取得しています…（${n}件）`).catch(() => {}),
        });
        if (messages.length === 0) {
          return interaction.editReply(`📭 書き出すメッセージがありません（システムメッセージ ${skippedSystem}件は除外）`);
        }

        const records = messages.map(m => messageRecord(m, guild));
        const files = buildJsonlFiles({
          guildId: GUILD_ID, channel, startId: lo, endId: records[records.length - 1].id,
          records, skippedSystem, exportedAt: toJstIso(Date.now()),
        });

        // 実行した人の DM に送る（チャンネルには流さない）
        const summary = `📄 **#${channel.name}** のメッセージを書き出しました（${records.length}件・システムメッセージ ${skippedSystem}件は除外）` +
          (truncated ? `\n⚠️ 上限の${MAX_MESSAGES.toLocaleString()}件に達したため、そこまでで止めました。続きは、最後のメッセージの次から改めて実行してください` : '') +
          (files.length > 1 ? `\n📎 ファイルが大きいため ${files.length} 個に分けています` : '');
        try {
          const dm = await interaction.user.createDM();
          for (let i = 0; i < files.length; i++) {
            await dm.send({
              content: i === 0 ? summary : `📎 ${i + 1}/${files.length}`,
              files: [new AttachmentBuilder(files[i].buffer, { name: files[i].name })],
              allowedMentions: { parse: [] },
            });
          }
        } catch (e) {
          if (e?.code === 50007) {
            return interaction.editReply('❌ DMを送れませんでした。サーバーの「プライバシー設定」で「ダイレクトメッセージ」を許可してから、もう一度実行してください');
          }
          throw e;
        }

        // ログには件数と所要時間だけを残す（本文は残さない）
        console.log(`📄 export_chat: ${records.length}件（システム ${skippedSystem}件除外・${files.length}ファイル${truncated ? '・上限で停止' : ''}）${((Date.now() - startedAt) / 1000).toFixed(1)}秒`);
        return interaction.editReply(`✅ DMに送りました（${records.length}件${truncated ? '・上限で停止' : ''}）`);
      } finally {
        running.delete(interaction.user.id);
      }
    },
  },
];
