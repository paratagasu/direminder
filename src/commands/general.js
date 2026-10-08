// 雑多なコマンド（GIF・ダイス・匿名・アクティビティ・purge など）
import { SlashCommandBuilder } from 'discord.js';
import { client } from '../client.js';
import { db } from '../db.js';
import { GUILD_ID, KLIPY_API_KEY, BOT_VERSION } from '../config.js';
import { isAdmin } from '../util.js';
import { getRandomGif, getRandomGifByCategory, generateRandomKatakana } from '../features/fun.js';

export const commands = [
  {
    data: new SlashCommandBuilder().setName('ping').setDescription('Bot疎通チェック'),
    async execute(interaction) {      return interaction.reply('Pong!');
    },
  },
  {
    data: new SlashCommandBuilder().setName('version').setDescription('Botのバージョンを表示する'),
    async execute(interaction) {
      return interaction.reply(`🤖 TKイベントリマインダーBot **v${BOT_VERSION}**`);
    },
  },
  {
    data: new SlashCommandBuilder().setName('dice').setDescription('サイコロを振る')
      .addIntegerOption(o => o.setName('faces').setDescription('面の数（2〜99999999999）').setRequired(true).setMinValue(2).setMaxValue(99999999999))
      .addIntegerOption(o => o.setName('count').setDescription('個数（1〜100）').setRequired(true).setMinValue(1).setMaxValue(100)),
    async execute(interaction) {
      const faces = interaction.options.getInteger('faces');
      const count = interaction.options.getInteger('count');
      const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * faces) + 1);
      const total = rolls.reduce((a, b) => a + b, 0);
      let msg = `🎲 **${interaction.user.displayName}** が **${count}d${faces}** を振りました！\n`;
      msg += count === 1 ? `結果: **${rolls[0]}**` : `結果: ${rolls.join(', ')}\n合計: **${total}**`;
      // 面数が大きいと100個で2000文字を超えるので合計だけにする
      if (msg.length > 2000) msg = `🎲 **${interaction.user.displayName}** が **${count}d${faces}** を振りました！\n合計: **${total}**（出目が多すぎるため個別表示は省略）`;
      return interaction.reply(msg);
    },
  },
  {
    data: new SlashCommandBuilder().setName('random-katakana').setDescription('ランダムカタカナ文字列を生成')
      .addIntegerOption(o => o.setName('length').setDescription('文字数（1〜100）').setRequired(true).setMinValue(1).setMaxValue(100)),
    async execute(interaction) {
      const len = interaction.options.getInteger('length');
      return interaction.reply(`${interaction.user.username} さんがコマンドを実行しました\n${generateRandomKatakana(len)}`);
    },
  },
  {
    data: new SlashCommandBuilder().setName('anonymous').setDescription('匿名メッセージを送信する')
      .addChannelOption(o => o.setName('channel').setDescription('送信先チャンネル').setRequired(true))
      .addStringOption(o => o.setName('message').setDescription('送信するメッセージ').setRequired(true)),
    async execute(interaction) {
      const targetChannel = interaction.options.getChannel('channel');
      const message = interaction.options.getString('message');
      console.log(`📨 匿名メッセージ: ${interaction.user.username} (${interaction.user.id}) → #${targetChannel.name} : "${message}"`);
      await interaction.deferReply({ flags: 64 });
      try {
        const ch = await client.channels.fetch(targetChannel.id);
        await ch.send(`🕵️ 誰かが匿名メッセージを送信しました\n${message}`);
        return interaction.editReply('✅ 匿名メッセージを送信しました');
      } catch (e) { return interaction.editReply(`❌ 送信失敗: ${e.message}`); }
    },
  },
  {
    data: new SlashCommandBuilder().setName('connection-change').setDescription('チャンネルの接続設定を変更する')
      .addChannelOption(o => o.setName('channel').setDescription('対象チャンネル').setRequired(true))
      .addStringOption(o => o.setName('serial-number').setDescription('シリアルナンバー').setRequired(true)),
    async execute(interaction) {
      if (!isAdmin(interaction)) return interaction.reply({ content: '⛔ 権限がありません', flags: 64 });
      await interaction.deferReply({ flags: 64 });
      const text = interaction.options.getString('serial-number');
      try {
        const ch = await client.channels.fetch(interaction.options.getChannel('channel').id);
        await ch.send(text);
        return interaction.editReply('✅ 接続設定を変更しました');
      } catch (e) { return interaction.editReply(`❌ 失敗: ${e.message}`); }
    },
  },
  {
    data: new SlashCommandBuilder().setName('gif-random').setDescription('ランダムなGIFを送信する'),
    async execute(interaction) {
      if (!KLIPY_API_KEY) return interaction.reply('⚠️ KLIPY_API_KEYが未設定です');
      await interaction.deferReply();
      try {
        const url = await getRandomGif();
        if (!url) return interaction.editReply('❌ GIFを取得できませんでした');
        return interaction.editReply(url);
      } catch (e) { return interaction.editReply(`❌ エラー: ${e.message}`); }
    },
  },
  {
    data: (ctx) => new SlashCommandBuilder().setName('gif-category').setDescription('カテゴリからランダムにGIFを送信する')
      .addStringOption(o => o.setName('category').setDescription('カテゴリ').setRequired(true).addChoices(...ctx.gifCategoryChoices)),
    async execute(interaction) {
      if (!KLIPY_API_KEY) return interaction.reply('⚠️ KLIPY_API_KEYが未設定です');
      await interaction.deferReply();
      const cat = interaction.options.getString('category');
      try {
        const url = await getRandomGifByCategory(cat);
        if (!url) return interaction.editReply('❌ GIFを取得できませんでした');
        return interaction.editReply(url);
      } catch (e) { return interaction.editReply(`❌ エラー: ${e.message}`); }
    },
  },
  {
    data: new SlashCommandBuilder().setName('activity-save')
      .setDescription('全チャンネルの現在の状態を記録する'),
    async execute(interaction) {
      await interaction.deferReply({ flags: 64 });
      try {
        const guild    = await client.guilds.fetch(GUILD_ID);
        const channels = await guild.channels.fetch();
        const snapshot = {};
        const now      = new Date().toISOString();

        for (const ch of channels.values()) {
          if (!ch) continue;
          if (ch.type !== 0 && ch.type !== 5 && ch.type !== 15) continue;
          try {
            const messages = await ch.messages.fetch({ limit: 1 });
            const last     = messages.first();
            snapshot[ch.id] = {
              name: ch.name, lastMessageId: last?.id ?? null,
              lastMessageAt: last?.createdAt?.toISOString() ?? null, messageCount: 0,
            };
          } catch (e) {}
          if (ch.threads) {
            const threads = await ch.threads.fetchActive().catch(() => null);
            if (threads) {
              for (const thread of threads.threads.values()) {
                try {
                  const msgs = await thread.messages.fetch({ limit: 1 });
                  const last = msgs.first();
                  snapshot[thread.id] = {
                    name: `#${ch.name} > ${thread.name}`, lastMessageId: last?.id ?? null,
                    lastMessageAt: last?.createdAt?.toISOString() ?? null, messageCount: 0,
                  };
                } catch (e) {}
              }
            }
          }
        }
        db.data.channelSnapshot = { savedAt: now, channels: snapshot };
        await db.write();
        const savedAtJst = new Date(now).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        return interaction.editReply(`✅ アクティビティを記録しました\n　保存日時: ${savedAtJst}\n　記録チャンネル数: ${Object.keys(snapshot).length}件`);
      } catch (e) { return interaction.editReply(`❌ エラー: ${e.message}`); }
    },
  },
  {
    data: new SlashCommandBuilder().setName('activity-check')
      .setDescription('前回の記録以降に更新のあったチャンネルを表示する'),
    async execute(interaction) {
      await interaction.deferReply({ flags: 64 });
      try {
        const snapshot = db.data.channelSnapshot;
        if (!snapshot?.savedAt) return interaction.editReply('⚠️ まだ記録がありません。先に `/activity-save` を実行してください。');
        const guild    = await client.guilds.fetch(GUILD_ID);
        const channels = await guild.channels.fetch();
        const savedAtJst = new Date(snapshot.savedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        const updated = [];
        for (const ch of channels.values()) {
          if (!ch) continue;
          if (ch.type !== 0 && ch.type !== 5 && ch.type !== 15) continue;
          const checkCh = async (channel, displayName) => {
            try {
              const saved = snapshot.channels[channel.id];
              const msgs  = await channel.messages.fetch({ limit: 1 });
              const last  = msgs.first();
              if (!last) return;
              if (!saved || last.id !== saved.lastMessageId) {
                let count = 0;
                if (saved?.lastMessageId) {
                  const newMsgs = await channel.messages.fetch({ limit: 100, after: saved.lastMessageId }).catch(() => null);
                  count = newMsgs?.size ?? 1;
                } else { count = 1; }
                const lastAtJst = last.createdAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });
                updated.push({ name: displayName, count, lastAt: lastAtJst, ts: last.createdTimestamp });
              }
            } catch (e) {}
          };
          await checkCh(ch, `#${ch.name}`);
          if (ch.threads) {
            const threads = await ch.threads.fetchActive().catch(() => null);
            if (threads) {
              for (const thread of threads.threads.values()) {
                await checkCh(thread, `#${ch.name} > ${thread.name}`);
              }
            }
          }
        }
        if (updated.length === 0) return interaction.editReply(`📭 **${savedAtJst}** 以降に更新のあったチャンネルはありません`);
        updated.sort((a, b) => b.ts - a.ts);
        let msg = `📊 **${savedAtJst}** から更新のあったチャンネル (${updated.length}件):\n\n`;
        for (const u of updated.slice(0, 25)) {
          msg += `**${u.name}**　新規 ${u.count}件　最終更新：${u.lastAt}\n`;
        }
        if (updated.length > 25) msg += `\n…他 ${updated.length - 25}件`;
        return interaction.editReply(msg.slice(0, 2000));
      } catch (e) { return interaction.editReply(`❌ エラー: ${e.message}`); }
    },
  },
  {
    data: new SlashCommandBuilder().setName('purge')
      .setDescription('指定時間前までのメッセージを削除する（管理者専用）')
      .addIntegerOption(o => o.setName('value').setDescription('数値').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('unit').setDescription('単位').setRequired(true)
        .addChoices(
          { name: '分前', value: 'minutes' },
          { name: '時間前', value: 'hours' },
        ))
      .addUserOption(o => o.setName('exclude-user').setDescription('削除しないメンバー（任意）').setRequired(false))
      .addUserOption(o => o.setName('only-user').setDescription('このメンバーのメッセージだけ削除（任意）').setRequired(false))
      .addStringOption(o => o.setName('match-text').setDescription('一致するメッセージだけ削除（任意）').setRequired(false))
      .addStringOption(o => o.setName('match-type').setDescription('一致方法').setRequired(false)
        .addChoices(
          { name: '部分一致', value: 'partial' },
          { name: '完全一致', value: 'exact' },
        )),
    async execute(interaction) {
      if (!isAdmin(interaction)) return interaction.reply({ content: '⛔ 管理者専用です', flags: 64 });
      const value       = interaction.options.getInteger('value');
      const unit        = interaction.options.getString('unit');
      const excludeUser = interaction.options.getUser('exclude-user');
      const onlyUser    = interaction.options.getUser('only-user');
      const matchText   = interaction.options.getString('match-text');
      const matchType   = interaction.options.getString('match-type') ?? 'partial';
      const msMap       = { minutes: 60 * 1000, hours: 60 * 60 * 1000 };
      const cutoff      = new Date(Date.now() - value * msMap[unit]);
      const cutoffJst   = cutoff.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
      await interaction.deferReply({ flags: 64 });
      try {
        const channel = interaction.channel;
        let allMessages = [];
        let lastId = null;
        for (let i = 0; i < 5; i++) {
          const opts = { limit: 100 };
          if (lastId) opts.before = lastId;
          const batch = await channel.messages.fetch(opts);
          const filtered = [...batch.values()].filter(m => m.createdAt >= cutoff);
          allMessages.push(...filtered);
          if (filtered.length < batch.size || batch.size < 100) break;
          lastId = batch.last()?.id;
        }
        let targets = allMessages;
        if (onlyUser)    targets = targets.filter(m => m.author.id === onlyUser.id);
        if (excludeUser) targets = targets.filter(m => m.author.id !== excludeUser.id);
        if (matchText)   targets = targets.filter(m => matchType === 'exact' ? m.content === matchText : m.content.includes(matchText));
        if (targets.length === 0) return interaction.editReply('📭 削除対象のメッセージがありませんでした');
        const oldest     = [...targets].sort((a, b) => a.createdTimestamp - b.createdTimestamp)[0];
        const confirmMsg = await oldest.reply({
          content: `**${cutoffJst}** までのメッセージを **${targets.length}件** 削除しますか？\n✅ で削除、❌ でキャンセル`,
          allowedMentions: { repliedUser: false }
        });
        await confirmMsg.react('✅');
        await confirmMsg.react('❌');
        await interaction.editReply('確認メッセージを送信しました');
        const filter    = (r, u) => ['✅','❌'].includes(r.emoji.name) && u.id === interaction.user.id;
        const collected = await confirmMsg.awaitReactions({ filter, max: 1, time: 60000 }).catch(() => null);
        const reaction  = collected?.first();
        if (!reaction || reaction.emoji.name === '❌') {
          await confirmMsg.edit('🚫 削除をキャンセルしました');
          return;
        }
        await confirmMsg.edit(`🗑️ ${targets.length}件のメッセージを削除中...`);
        const now14  = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
        const bulk   = targets.filter(m => m.createdAt > now14 && m.id !== confirmMsg.id);
        const single = targets.filter(m => m.createdAt <= now14 && m.id !== confirmMsg.id);
        // 実際に削除できた件数だけ数える
        let deleted = 0;
        for (let i = 0; i < bulk.length; i += 100) {
          const res = await channel.bulkDelete(bulk.slice(i, i + 100), true).catch(() => null);
          deleted += res?.size ?? 0;
        }
        let singleTried = 0;
        for (const m of single) {
          if (await m.delete().then(() => true).catch(() => false)) deleted++;
          if (++singleTried % 10 === 0) await new Promise(r => setTimeout(r, 1000));
        }
        await confirmMsg.edit(`✅ ${deleted}件のメッセージを削除しました`);
        console.log(`🗑️ purge: ${interaction.user.username} が #${channel.name} で ${deleted}件削除`);
      } catch (e) { await interaction.editReply(`❌ エラー: ${e.message}`).catch(() => {}); }
      return;
    },
  },
];
