// グッジョブ
import {
  SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
} from 'discord.js';
import { EPHEMERAL } from '../util.js';
import { client } from '../client.js';
import { db } from '../db.js';
import { GUILD_ID } from '../config.js';
import { getGjPoints, sendGoodJob } from '../gj.js';

export const commands = [
  {
    data: new SlashCommandBuilder().setName('goodjob').setDescription('グッジョブを送信する')
      .addUserOption(o => o.setName('target').setDescription('対象ユーザー').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('一言コメント（任意）').setRequired(false))
      .addBooleanOption(o => o.setName('anonymous').setDescription('匿名にする（匿名はGSP付与なし）').setRequired(false)),
    async execute(interaction) {
      const target    = interaction.options.getUser('target');
      const reason    = interaction.options.getString('reason') ?? null;
      const anonymous = interaction.options.getBoolean('anonymous') ?? false;
      if (anonymous) {
        console.log(`👍 匿名GJ送信: ${interaction.user.username} (${interaction.user.id}) → ${target.username} (${target.id})`);
      }
      if (target.bot) return interaction.reply({ content: '❌ Botにはグッジョブを送れません', flags: 64 });
      // 実績・コンボ通知などで3秒を超えることがあるので先に応答を保留する
      await interaction.deferReply({ flags: 64 });
      const guild      = await client.guilds.fetch(GUILD_ID);
      const fromMember = await guild.members.fetch(interaction.user.id).catch(() => null);
      const toMember   = await guild.members.fetch(target.id).catch(() => null);
      if (!fromMember || !toMember) return interaction.editReply('❌ ユーザーが見つかりません');
      const ch = await client.channels.fetch(interaction.channelId);
      const result = await sendGoodJob(db, client, GUILD_ID, {
        fromId: interaction.user.id, fromName: fromMember.displayName,
        toId: target.id, toName: toMember.displayName,
        reason, anonymous, channel: ch
      });
      if (!result.success) return interaction.editReply(result.reason);
      return interaction.editReply('✅ グッジョブを送信しました！');
    },
  },
  {
    data: new SlashCommandBuilder().setName('goodjob-history').setDescription('グッジョブ履歴を確認する')
      .addUserOption(o => o.setName('target').setDescription('確認するユーザー（省略で自分）').setRequired(false)),
    async execute(interaction) {
      const target = interaction.options.getUser('target') ?? interaction.user;
      const now    = Date.now();
      const days30 = 30 * 24 * 60 * 60 * 1000;
      const recent = (db.data.gjData.history ?? []).filter(h =>
        h.to === target.id && now - new Date(h.timestamp).getTime() < days30
      );
      const total  = (db.data.gjData.history ?? []).filter(h => h.to === target.id).length;
      const points = getGjPoints(db, target.id);
      let msg = `📊 **${target.displayName ?? target.username}** のグッジョブ履歴
`;
      msg += `過去30日で **${recent.length}回** のグッジョブを受けています（累計: ${total}回 / GJP: ${points.gjp}）
`;
      const reasons = recent.filter(h => h.reason).slice(-5).map(h => `・${h.reason}`);
      if (reasons.length > 0) msg += `\n最近の理由：\n${reasons.join('\n')}`;
      return interaction.reply({ content: msg, flags: 64 });
    },
  },
  {
    data: new SlashCommandBuilder().setName('goodjob-status').setDescription('自分のグッジョブステータスを確認する'),
    async execute(interaction) {
      const userId = interaction.user.id;
      const points = getGjPoints(db, userId);
      const mc     = db.data.gjData.monthlyCounters?.[userId] ?? { monthlyGjp: 0, monthlyGsp: 0 };
      const ach    = db.data.gjData.achievements?.[userId] ?? { received: [], sent: [] };

      const achLabels = {
        received: { first: '🌱 初GJ', '10': '👍 GJ 10回', '100': '🔥 GJ 100回', '500': '👑 GJ 500回', '10src': '💎 10人以上からGJ', '7streak': '🌟 7日連続GJ' },
        sent:     { first: '🤝 初GJ送信', '10tgt': '❤️ 10人にGJ', '20tgt': '🌎 20人以上にGJ', '10day': '🫂 1日10GJ' },
      };

      const receivedAch = ach.received.map(k => achLabels.received[k] ?? k).join('、') || '（なし）';
      const sentAch     = ach.sent.map(k => achLabels.sent[k] ?? k).join('、') || '（なし）';

      const now = Date.now();
      const history = db.data.gjData.history ?? [];
      const received30 = history.filter(h => h.to === userId && now - new Date(h.timestamp).getTime() < 30 * 24 * 60 * 60 * 1000).length;
      const sent30     = history.filter(h => h.from === userId && !h.anonymous && now - new Date(h.timestamp).getTime() < 30 * 24 * 60 * 60 * 1000).length;

      const msg = [
        `📊 **${interaction.user.displayName ?? interaction.user.username}** のGJステータス`,
        '',
        `**📈 累計**`,
        `　GJP（受け取り）: ${points.gjp}`,
        `　GSP（送り）: ${points.gsp}`,
        '',
        `**📅 今月**`,
        `　GJP: ${mc.monthlyGjp}　GSP: ${mc.monthlyGsp}`,
        '',
        `**📆 過去30日**`,
        `　受け取ったGJ: ${received30}回　送ったGJ: ${sent30}回`,
        '',
        `**🏆 解除済み実績**`,
        `　受け取り側: ${receivedAch}`,
        `　送り側: ${sentAch}`,
      ].join('\n');

      return interaction.reply({ content: msg, flags: 64 });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('goodjob-ranking').setDescription('グッジョブランキングを表示する')
      .addStringOption(o => o.setName('period').setDescription('集計期間（省略で累計）')
        .addChoices({ name: '累計', value: 'total' }, { name: '今月', value: 'month' }))
      .addStringOption(o => o.setName('type').setDescription('ランキングの種類（省略で受け取り）')
        .addChoices({ name: '受け取り（GJP）', value: 'gjp' }, { name: '送り（GSP）', value: 'gsp' })),
    async execute(interaction) {
      const period = interaction.options.getString('period') ?? 'total';
      const type   = interaction.options.getString('type') ?? 'gjp';
      const source = period === 'month'
        ? Object.entries(db.data.gjData.monthlyCounters ?? {}).map(([uid, c]) => [uid, { gjp: c.monthlyGjp ?? 0, gsp: c.monthlyGsp ?? 0 }])
        : Object.entries(db.data.gjData.points ?? {});
      const sorted = source.filter(([, p]) => (p[type] ?? 0) > 0).sort((a, b) => b[1][type] - a[1][type]).slice(0, 10);
      const title = `🏆 **グッジョブランキング**（${period === 'month' ? '今月' : '累計'}・${type === 'gjp' ? '受け取り' : '送り'}）`;
      if (sorted.length === 0) return interaction.reply(`${title}\n📭 まだ記録がありません`);
      await interaction.deferReply();
      const guild = await client.guilds.fetch(GUILD_ID);
      const medals = ['🥇', '🥈', '🥉'];
      const lines = [title, ''];
      // 同点は同じ順位にする
      let rank = 0, prev = null;
      for (let i = 0; i < sorted.length; i++) {
        const [uid, pts] = sorted[i];
        if (pts[type] !== prev) { rank = i; prev = pts[type]; }
        const m = await guild.members.fetch(uid).catch(() => null);
        const name = m?.displayName ?? uid;
        const medal = medals[rank] ?? `${rank + 1}.`;
        const main = type === 'gjp' ? `**${pts.gjp} GJP**` : `**${pts.gsp} GSP**`;
        const sub  = type === 'gjp' ? `${pts.gsp} GSP` : `${pts.gjp} GJP`;
        lines.push(`${medal} **${name}** - ${main} / ${sub}`);
      }
      return interaction.editReply(lines.join('\n'));
    },
  },
  // 右クリック →「アプリ」から送るGJ
  {
    data: new ContextMenuCommandBuilder().setName('このメッセージにGJ').setType(ApplicationCommandType.Message),
    async execute(interaction) {
      const author = interaction.targetMessage.author;
      return showGjModal(interaction, author, interaction.targetMessage.url);
    },
  },
  {
    data: new ContextMenuCommandBuilder().setName('GJを送る').setType(ApplicationCommandType.User),
    async execute(interaction) {
      return showGjModal(interaction, interaction.targetUser, null);
    },
  },
];

async function showGjModal(interaction, target, messageUrl) {
  if (target.bot) return interaction.reply({ content: '❌ Botにはグッジョブを送れません', flags: EPHEMERAL });
  if (target.id === interaction.user.id) return interaction.reply({ content: '❌ 自分自身にGJは送れません', flags: EPHEMERAL });
  const guild  = await client.guilds.fetch(GUILD_ID);
  const member = await guild.members.fetch(target.id).catch(() => null);
  const name   = member?.displayName ?? target.username;
  const modal = new ModalBuilder()
    .setCustomId(`gj:${target.id}:${messageUrl ? 'msg' : 'user'}`)
    .setTitle(`${name} にGJを送る`.slice(0, 45))
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('reason').setLabel('ひとこと（空欄でもOK）')
        .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(200)
        .setPlaceholder('例: 資料まとめてくれてありがとう！'),
    ));
  return interaction.showModal(modal);
}

// モーダル送信時（customId: gj:<相手のID>:<msg|user>）
export const components = {
  gj: async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    const [, toId] = interaction.customId.split(':');
    const reason = interaction.fields.getTextInputValue('reason')?.trim() || null;
    await interaction.deferReply({ flags: EPHEMERAL });
    const guild      = await client.guilds.fetch(GUILD_ID);
    const fromMember = await guild.members.fetch(interaction.user.id).catch(() => null);
    const toMember   = await guild.members.fetch(toId).catch(() => null);
    if (!fromMember || !toMember) return interaction.editReply('❌ ユーザーが見つかりません');
    const ch = await client.channels.fetch(interaction.channelId);
    const result = await sendGoodJob(db, client, GUILD_ID, {
      fromId: interaction.user.id, fromName: fromMember.displayName,
      toId, toName: toMember.displayName,
      reason, anonymous: false, channel: ch,
    });
    if (!result.success) return interaction.editReply(result.reason);
    return interaction.editReply(`✅ ${toMember.displayName} にグッジョブを送信しました！`);
  },
};
