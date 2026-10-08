// メンバー表の管理（Discordアカウント ↔ Googleカレンダー）
import { SlashCommandBuilder } from 'discord.js';
import { db } from '../db.js';
import { getMembers, findMemberByName, findMemberByDiscordId, memberNameChoices } from '../members.js';
import { isAdmin, replyLong, EPHEMERAL } from '../util.js';

const adminOnly = interaction => interaction.reply({ content: '⛔ 管理者専用です', flags: EPHEMERAL });
const autocompleteName = interaction => interaction.respond(memberNameChoices(interaction.options.getFocused()));

export const commands = [
  {
    data: new SlashCommandBuilder().setName('member-list').setDescription('登録メンバー（カレンダー・出欠の対象）の一覧'),
    async execute(interaction) {
      const members = getMembers();
      if (members.length === 0) return interaction.reply({ content: '📭 メンバーは登録されていません', flags: EPHEMERAL });
      await interaction.deferReply({ flags: EPHEMERAL });
      const lines = [`👥 **登録メンバー** (${members.length}名)`, ''];
      for (const m of members) {
        const accounts = (m.discordIds ?? []).map((id, i) => `<@${id}>${i === 0 ? '（メイン）' : ''}`).join(' ');
        lines.push(`**${m.name}**　表示: ${m.label || '―'}　カレンダー: ${m.calendarId ? '✅' : '―'}`, `　${accounts || 'アカウント未登録'}`);
      }
      return replyLong(interaction, lines.join('\n'), { ephemeral: true });
    },
  },
  {
    data: new SlashCommandBuilder().setName('member-add').setDescription('メンバーを追加・更新する（管理者専用）')
      .addStringOption(o => o.setName('name').setDescription('呼び名（例: しいたけ）').setRequired(true).setMaxLength(32).setAutocomplete(true))
      .addUserOption(o => o.setName('user').setDescription('Discordアカウント（新規追加時は必須・メインアカウント）'))
      .addStringOption(o => o.setName('calendar-id').setDescription('GoogleカレンダーID（〜@group.calendar.google.com）'))
      .addStringOption(o => o.setName('label').setDescription('カレンダー予定名の頭に付ける表示（例: 【川畑】・省略で【呼び名】）').setMaxLength(32)),
    autocomplete: autocompleteName,
    async execute(interaction) {
      if (!isAdmin(interaction)) return adminOnly(interaction);
      const name       = interaction.options.getString('name').trim();
      const user       = interaction.options.getUser('user');
      const calendarId = interaction.options.getString('calendar-id')?.trim();
      const label      = interaction.options.getString('label')?.trim();
      let member = findMemberByName(name);
      if (user) {
        const owner = findMemberByDiscordId(user.id);
        if (owner && owner !== member) return interaction.reply({ content: `❌ <@${user.id}> はすでに「${owner.name}」に登録されています`, flags: EPHEMERAL, allowedMentions: { parse: [] } });
      }
      if (!member) {
        if (!user) return interaction.reply({ content: '❌ 新しいメンバーを追加するときは user を指定してください', flags: EPHEMERAL });
        member = { name, label: label || `【${name}】`, discordIds: [user.id], calendarId: calendarId || null };
        db.data.members.push(member);
      } else {
        if (user && !member.discordIds.includes(user.id)) member.discordIds.push(user.id);
        if (calendarId) member.calendarId = calendarId;
        if (label) member.label = label;
      }
      await db.write();
      return interaction.reply({
        content: `✅ メンバー「${member.name}」を保存しました\n　アカウント: ${member.discordIds.map(id => `<@${id}>`).join(' ')}\n　表示: ${member.label}\n　カレンダー: ${member.calendarId ?? '（未設定）'}`,
        flags: EPHEMERAL, allowedMentions: { parse: [] },
      });
    },
  },
  {
    data: new SlashCommandBuilder().setName('member-link').setDescription('メンバーにサブアカウントを追加する（管理者専用）')
      .addStringOption(o => o.setName('name').setDescription('メンバーの呼び名').setRequired(true).setAutocomplete(true))
      .addUserOption(o => o.setName('user').setDescription('追加するDiscordアカウント').setRequired(true)),
    autocomplete: autocompleteName,
    async execute(interaction) {
      if (!isAdmin(interaction)) return adminOnly(interaction);
      const member = findMemberByName(interaction.options.getString('name'));
      const user   = interaction.options.getUser('user');
      if (!member) return interaction.reply({ content: '❌ そのメンバーは登録されていません', flags: EPHEMERAL });
      const owner = findMemberByDiscordId(user.id);
      if (owner) return interaction.reply({ content: `❌ <@${user.id}> はすでに「${owner.name}」に登録されています`, flags: EPHEMERAL, allowedMentions: { parse: [] } });
      member.discordIds.push(user.id);
      await db.write();
      return interaction.reply({ content: `✅ 「${member.name}」に <@${user.id}> を追加しました`, flags: EPHEMERAL, allowedMentions: { parse: [] } });
    },
  },
  {
    data: new SlashCommandBuilder().setName('member-unlink').setDescription('メンバーからDiscordアカウントを外す（管理者専用）')
      .addUserOption(o => o.setName('user').setDescription('外すDiscordアカウント').setRequired(true)),
    async execute(interaction) {
      if (!isAdmin(interaction)) return adminOnly(interaction);
      const user = interaction.options.getUser('user');
      const member = findMemberByDiscordId(user.id);
      if (!member) return interaction.reply({ content: '❌ そのアカウントはどのメンバーにも登録されていません', flags: EPHEMERAL });
      if (member.discordIds.length === 1) return interaction.reply({ content: `❌ 「${member.name}」の最後のアカウントです。メンバーごと消す場合は /member-remove を使ってください`, flags: EPHEMERAL });
      member.discordIds = member.discordIds.filter(id => id !== user.id);
      await db.write();
      return interaction.reply({ content: `✅ 「${member.name}」から <@${user.id}> を外しました`, flags: EPHEMERAL, allowedMentions: { parse: [] } });
    },
  },
  {
    data: new SlashCommandBuilder().setName('member-remove').setDescription('メンバーを削除する（管理者専用）')
      .addStringOption(o => o.setName('name').setDescription('メンバーの呼び名').setRequired(true).setAutocomplete(true)),
    autocomplete: autocompleteName,
    async execute(interaction) {
      if (!isAdmin(interaction)) return adminOnly(interaction);
      const name = interaction.options.getString('name');
      const before = db.data.members.length;
      db.data.members = db.data.members.filter(m => m.name !== name);
      if (db.data.members.length === before) return interaction.reply({ content: '❌ そのメンバーは登録されていません', flags: EPHEMERAL });
      await db.write();
      return interaction.reply({ content: `🗑️ メンバー「${name}」を削除しました`, flags: EPHEMERAL });
    },
  },
];
