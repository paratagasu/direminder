import cron from "node-cron";
import fetch from "node-fetch"; // Node.js 18未満対策

const PORT = process.env.PORT || 3000;
const HEALTH_CHECK_URL =
  process.env.HEALTH_CHECK_URL || `http://localhost:${PORT}`;

// 10分ごとにヘルスチェック
export function startHealthCheckCron() {
  cron.schedule("*/10 * * * *", async () => {
    const now = new Date().toLocaleString("ja-JP");
    try {
      console.log(`🔍 [${now}] ヘルスチェック実行中... (${HEALTH_CHECK_URL})`);
      const response = await fetch(HEALTH_CHECK_URL);

      if (response.ok) {
        console.log(`✅ [${now}] ヘルスチェック成功: ${response.status}`);
      } else {
        console.warn(`⚠️ [${now}] ヘルスチェック失敗: ${response.status}`);
      }
    } catch (error) {
      console.error(`❌ [${now}] ヘルスチェックエラー:`, error);
    }
  }, {
    timezone: "Asia/Tokyo"
  });

  console.log("🕐 ヘルスチェックの定期実行を開始しました (10分間隔)");
}