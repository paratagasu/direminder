// index.js - TKイベントリマインダーBot エントリーポイント
// 機能ごとのコードは src/ 以下にあります（README.md 参照）
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import cron from 'node-cron';
import { Events } from 'discord.js';
import { DISCORD_TOKEN, PORT, HEALTH_CHECK_URL, KLIPY_API_KEY, BOT_VERSION } from './src/config.js';
import { client } from './src/client.js';
import { db } from './src/db.js';
import { bootstrapSchedules } from './src/schedules.js';
import { registerEventHandlers, reconcileAttendance } from './src/features/events.js';
import { registerReactionHandlers } from './src/features/reactions.js';
import { getKlipyCategories } from './src/features/fun.js';
import { registerCommands, registerInteractionHandler } from './src/commands/index.js';
import { restoreFromBackup, flushBackup } from './src/backup.js';

// ============================================================
// Hono サーバー（Koyeb / UptimeRobot のヘルスチェック用）
// ============================================================
const app = new Hono();
app.get('/', (c) => c.json({ status: 'ok', version: BOT_VERSION, timestamp: new Date().toISOString() }));
serve({ fetch: app.fetch, port: PORT });
console.log(`🌐 Web server running on port ${PORT}`);

cron.schedule('*/10 * * * *', async () => {
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  try {
    const res = await fetch(HEALTH_CHECK_URL);
    if (res.ok) console.log(`✅ [${now}] ヘルスチェック成功: ${res.status}`);
  } catch (e) { console.error(`❌ ヘルスチェックエラー:`, e.message); }
}, { timezone: 'Asia/Tokyo' });

// ============================================================
// イベントハンドラ
// ============================================================
registerEventHandlers();
registerReactionHandlers();
registerInteractionHandler();

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag} (v${BOT_VERSION})`);

  // 1. 自動バックアップから復元（スケジュール登録より先に行う）
  await restoreFromBackup();
  console.log(`   → morningTime = ${db.data.morningTime}`);
  console.log(`   → offsets     = ${db.data.reminderOffsets.join(',')}`);

  // 2. スケジュール開始（コマンド登録に失敗してもリマインド等は動くように先に行う）
  bootstrapSchedules();

  // 3. 停止中に付け外しされた✅を反映
  reconcileAttendance().catch(e => console.error('出欠突き合わせ失敗:', e.message));

  // 4. コマンド登録（GIFカテゴリはKlipyから取得してchoicesに使う）
  try {
    const gifCategoryChoices = await buildGifCategoryChoices();
    await registerCommands({ gifCategoryChoices });
  } catch (e) {
    console.error('❌ スラッシュコマンド登録失敗:', e);
  }
});

async function buildGifCategoryChoices() {
  const cats = KLIPY_API_KEY ? await getKlipyCategories().catch(() => []) : [];
  console.log(`🎬 Klipyカテゴリ取得: ${cats.length}件`);
  // Discordのchoicesは name/value とも1〜100文字・value重複不可・最大25件
  const seen = new Set();
  const choices = cats
    .map(c => (typeof c === 'string' ? { name: c, value: c } : { name: c?.name ?? c?.slug, value: c?.slug ?? c?.name }))
    .map(c => ({ name: String(c.name ?? '').slice(0, 100), value: String(c.value ?? '').slice(0, 100) }))
    .filter(c => c.name && c.value && !seen.has(c.value) && seen.add(c.value))
    .slice(0, 25);
  if (choices.length > 0) return choices;
  // カテゴリが取れなかった場合はフォールバック
  return [
    { name: '喜び', value: 'happy' }, { name: '怒り', value: 'angry' },
    { name: '悲しみ', value: 'sad' }, { name: '驚き', value: 'surprised' },
    { name: '困惑', value: 'confused' }, { name: 'OK/了解', value: 'ok' },
    { name: 'ありがとう', value: 'thank you' }, { name: 'ごめん', value: 'sorry' },
    { name: '草/笑', value: 'laughing' }, { name: '最高', value: 'awesome' },
  ];
}

// ============================================================
// グローバルエラーハンドラー（Botのクラッシュを防ぐ）
// ============================================================
process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled rejection:', error?.message ?? error);
});
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error?.message ?? error);
});
client.on(Events.Error, (error) => {
  console.error('❌ Discord client error:', error?.message ?? error);
});

// 終了時（再デプロイ時など）は未保存の変更をバックアップしてから終わる
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, async () => {
    console.log(`🛑 ${sig} を受信。バックアップして終了します`);
    await Promise.race([flushBackup(), new Promise(r => setTimeout(r, 8000))]);
    process.exit(0);
  });
}

client.login(DISCORD_TOKEN);
