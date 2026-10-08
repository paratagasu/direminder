// 環境変数・定数
import * as dotenv from 'dotenv';
dotenv.config();

export const {
  DISCORD_TOKEN, GUILD_ID, ANNOUNCE_CHANNEL_ID,
  GOOGLE_SERVICE_ACCOUNT_KEY, GOOGLE_CALENDAR_ID,
  KLIPY_API_KEY,
  // 自動バックアップ先（管理者とBotだけが見られる非公開チャンネル）。未設定なら自動バックアップは無効
  BACKUP_CHANNEL_ID,
} = process.env;

export const PORT = process.env.PORT ?? 3000;
export const HEALTH_CHECK_URL = process.env.HEALTH_CHECK_URL || `http://localhost:${PORT}`;
export const DEFAULT_REMIND_CHANNEL_ID = '1357515614498848909';
export const BOT_VERSION = '2.35.0';

if (!DISCORD_TOKEN || !GUILD_ID || !ANNOUNCE_CHANNEL_ID) {
  console.error('⚠️ 必要な環境変数が不足しています');
  process.exit(1);
}
