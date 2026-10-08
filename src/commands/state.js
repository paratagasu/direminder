// 状態のエクスポート・インポート・自動バックアップ
import { SlashCommandBuilder, AttachmentBuilder } from 'discord.js';
import { isAdmin, EPHEMERAL } from '../util.js';
import { formatJst } from '../time.js';
import { buildStateExport, applyState, summarizeState } from '../state.js';
import { bootstrapSchedules } from '../schedules.js';
import { reconcileAttendance } from '../features/events.js';
import { backupStatus, runBackup, enableBackup } from '../backup.js';

const adminOnly = interaction => interaction.reply({ content: '⛔ 管理者専用です', flags: EPHEMERAL });

export const commands = [
  {
    data: new SlashCommandBuilder().setName('state-export').setDescription('Botの全状態をJSONでエクスポート（管理者専用）'),
    async execute(interaction) {
      if (!isAdmin(interaction)) return adminOnly(interaction);
      const buf = Buffer.from(JSON.stringify(buildStateExport(), null, 2), 'utf-8');
      const filename = `bot-state-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
      return interaction.reply({
        content: `✅ 状態をエクスポートしました（${formatJst(new Date())}）`,
        files: [new AttachmentBuilder(buf, { name: filename })],
        flags: EPHEMERAL,
      });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('state-import').setDescription('JSONファイルからBotの状態をインポート（管理者専用）')
      .addAttachmentOption(o => o.setName('file').setDescription('エクスポートしたJSONファイル').setRequired(true)),
    async execute(interaction) {
      if (!isAdmin(interaction)) return adminOnly(interaction);
      await interaction.deferReply({ flags: EPHEMERAL });
      const att = interaction.options.getAttachment('file');
      let json;
      try {
        json = await (await fetch(att.url)).json();
        await applyState(json);
      } catch (e) { return interaction.editReply(`❌ インポート失敗: ${e.message}`); }
      bootstrapSchedules();
      // 手動インポートした状態を正として自動バックアップも再開する
      enableBackup();
      // インポート前・停止中に付け外しされた✅を反映（旧形式のメッセージはボタン式に変換）
      const rec = await reconcileAttendance().catch(e => { console.error('出欠突き合わせ失敗:', e.message); return null; });
      return interaction.editReply(
        `✅ 状態をインポートしました\n　エクスポート日時: ${formatJst(json.exportedAt)}\n` +
        summarizeState(json) + '\n' +
        (rec
          ? `　出欠: 変換 ${rec.converted}件 / ロール付与 ${rec.added}名 / 解除 ${rec.removed}名\n\n`
          : `　⚠️ 出欠の反映に失敗しました（ログを確認してください）\n\n`) +
        `cronを再登録しました。リマインド収集はそのまま継続されます。`
      );
    },
  },
  {
    data: new SlashCommandBuilder().setName('backup-status').setDescription('自動バックアップの状態を表示（管理者専用）'),
    async execute(interaction) {
      if (!isAdmin(interaction)) return adminOnly(interaction);
      const s = backupStatus;
      return interaction.reply({
        content: [
          '🗄️ **自動バックアップ**',
          `　保存先: ${s.configured ? `✅ ${s.target}` : '❌ 未設定（環境変数 BACKUP_USER_ID か BACKUP_CHANNEL_ID を設定してください）'}`,
          `　暗号化: ${s.encrypted ? '🔒 あり' : '⚠️ なし（BACKUP_ENCRYPTION_KEY を設定すると暗号化されます）'}`,
          `　動作: ${s.enabled ? '✅ 有効' : '⏸ 停止中'}`,
          `　起動時の復元: ${s.restoreResult ?? '―'}`,
          `　最終バックアップ: ${s.lastBackupAt ? formatJst(s.lastBackupAt) : '―'}`,
          s.lastError ? `　⚠️ 直近のエラー: ${s.lastError}` : null,
        ].filter(Boolean).join('\n'),
        flags: EPHEMERAL,
      });
    },
  },
  {
    data: new SlashCommandBuilder().setName('backup-now').setDescription('今すぐ自動バックアップを実行する（管理者専用）'),
    async execute(interaction) {
      if (!isAdmin(interaction)) return adminOnly(interaction);
      if (!backupStatus.configured) return interaction.reply({ content: '❌ BACKUP_USER_ID / BACKUP_CHANNEL_ID が未設定です', flags: EPHEMERAL });
      await interaction.deferReply({ flags: EPHEMERAL });
      enableBackup();
      try {
        await runBackup({ force: true });
        return interaction.editReply('✅ バックアップしました（自動バックアップも有効になっています）');
      } catch (e) { return interaction.editReply(`❌ バックアップ失敗: ${e.message}`); }
    },
  },
];
