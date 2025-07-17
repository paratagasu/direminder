// cron.js

import cron from "node-cron";
import * as dotenv from "dotenv";
dotenv.config();

// PORT とエンドポイントを環境変数 or デフォルトで設定
const PORT = process.env.PORT || 3000;
const HEALTH_CHECK_PATH = process.env.HEALTH_CHECK_PATH || "/health";
const HEALTH_CHECK_URL =
  process.env.HEALTH_CHECK_URL ||
  `http://localhost:${PORT}${HEALTH_CHECK_PATH}`;

// 10分ごとにヘルスチェック
export function startHealthCheckCron() {
  cron.schedule(
    "*/10 * * * *",
    async () => {
      const now = new Date().toLocaleString("ja-JP");
      console.log(`🔍 [${now}] ヘルスチェック実行中... (${HEALTH_CHECK_URL})`);
      try {
        // Node.js v18+ のグローバル fetch を使用
        const res = await fetch(HEALTH_CHECK_URL);
        if (res.ok) {
          console.log(`✅ [${now}] ヘルスチェック成功: ${res.status}`);
        } else {
          console.warn(`⚠️ [${now}] ヘルスチェック失敗: ${res.status}`);
        }
      } catch (err) {
        console.error(`❌ [${now}] ヘルスチェックエラー:`, err);
      }
    },
    { timezone: "Asia/Tokyo" }
  );

  console.log("🕐 ヘルスチェックの定期実行を開始しました (10分間隔)");
}