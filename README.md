# TKイベントリマインダーBot

Discord のイベントリマインド・出欠管理・Googleカレンダー連携・グッジョブ(GJ)システムを持つBotです。

- ホスティング: Koyeb（Dockerfile でビルド / Node.js 22）
- 死活監視: UptimeRobot（`/` にヘルスチェック用のJSONを返す）

## ファイル構成

```
index.js                  エントリーポイント（起動順序・ヘルスチェック・終了処理）
src/
  config.js               環境変数・定数（BOT_VERSION もここ）
  client.js               Discordクライアント
  db.js                   状態の保存（settings.json）
  state.js                状態のエクスポート／インポート
  backup.js               自動バックアップ・起動時の自動復元
  schedules.js            定期実行の登録
  cron.js                 cron管理
  time.js / util.js       日時・共通ヘルパー
  members.js              メンバー表（Discordアカウント ↔ カレンダー）
  members.default.js      メンバー表の初期値（初回起動時のみ使用）
  calendar.js             Googleカレンダー連携・空き時間検索
  gj.js                   グッジョブシステム
  features/
    events.js             朝リマインド・出欠ボタン・各種リマインド・VC参加記録
    reactions.js          リアクションの振り分け（GJ・出欠・予定削除）
    saylater.js           伝言予約（1回きり・定期）
    fun.js                GIF・ランダムカタカナ
  commands/               スラッシュコマンド（機能ごとにファイルを分割）
    index.js              コマンド登録・振り分け
```

コマンドを追加するときは `src/commands/` の該当ファイルの `commands` 配列に `{ data, execute }` を足すだけで登録されます。

## 環境変数（Koyeb）

| 変数名 | 用途 |
|---|---|
| `DISCORD_TOKEN` | BotのDiscordトークン |
| `GUILD_ID` | 対象サーバーID |
| `ANNOUNCE_CHANNEL_ID` | リマインド送信先チャンネルID |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | GoogleサービスアカウントJSON（1行） |
| `GOOGLE_CALENDAR_ID` | イベント登録先カレンダーID |
| `KLIPY_API_KEY` | GIF配信API |
| `BACKUP_USER_ID` | **自動バックアップを送るユーザーID**（そのユーザーへのDMに保存・推奨） |
| `BACKUP_CHANNEL_ID` | 自動バックアップ先チャンネルID（`BACKUP_USER_ID` が無いときに使用） |
| `BACKUP_ENCRYPTION_KEY` | 設定するとバックアップを暗号化（任意の長い文字列・推奨） |

## 自動バックアップ

Koyeb はリデプロイのたびに `settings.json` が消えるため、Botの状態を Discord に自動保存します。

**おすすめ設定**
1. `BACKUP_USER_ID` に保管役の人（Botと同じサーバーにいる人）のDiscordユーザーIDを設定 → その人へのDMに保存されます。他の管理者からは見えず、DMでは相手のメッセージを削除できないので誤って消される心配もありません
2. `BACKUP_ENCRYPTION_KEY` に長いランダムな文字列（20文字以上推奨）を設定 → バックアップが AES-256-GCM で暗号化され、鍵が無いと中身を読めません

- Botは保存先に **メッセージを1件だけ** 置き、変更があるたびに **上書き編集** します。編集は通知も未読も付きません（最初の1回も @silent で投稿）。
- 起動時にそのメッセージから自動で状態を復元します。再デプロイ時（終了シグナル受信時）にも最新の状態を書き出します。
- 復元に失敗したとき（鍵の間違いなど）は、正しいバックアップを壊さないよう自動バックアップを止めます。`/backup-status` で状態を確認し、`/state-import` で手動復元するか `/backup-now` で今の状態から再開してください。
- **暗号化の鍵を変える・失くすと既存のバックアップは読めなくなります。** 鍵を変えるときは、変更後に `/backup-now` を実行してください。
- 保管役の人がサーバーを抜ける・BotをブロックするとDMに保存できなくなります。
- チャンネルに保存する場合（`BACKUP_CHANNEL_ID`）は、直近2000件までさかのぼって探します。`/purge` ではバックアップは消えません。

`/state-export` `/state-import` による手動の引き継ぎも引き続き使えます（`/state-export` のファイルは暗号化されません）。

## 主なコマンド

**イベント・出欠**
- 毎朝、イベントごとに出欠カード（埋め込み）を1枚投稿。「出席／欠席」ボタンを押すと本人にだけ結果が表示され、カードの出席・欠席・未回答がリアルタイムに更新されます（もう一度押すと取り消し）
- 出欠はメンバー表の「名前」単位で集計。アカウントを複数持つ人は、どれか1つでも押していれば回答済み（出席が欠席より優先）
- リマインドはイベント専用ロールへのメンション。次のリマインド・開始アナウンスを送ると、ひとつ前のリマインドは自動で消えます
- `/set-morning-time` `/add-reminder-offset` `/remove-reminder-offset` `/list-reminder-offsets` `/week-events` `/force-remind` `/n-force-remind` `/debug-events`

**カレンダー**
- `/tm` `/tm-week` 指定時刻の予定確認
- `/tm-free` 全員（または指定人数以上）が空いている時間帯を探す
- `/cal-add` `/cal-add-allday` `/cal-delete` 自分のカレンダーに予定を追加・削除

**メンバー管理（管理者）**
- `/member-list` `/member-add` `/member-link`（サブ垢追加） `/member-unlink` `/member-remove`

**伝言予約**
- `/saylatter-rel` `/saylatter-abs` `/saylatter-list` `/saylatter-cancel`
- 定期: `/saylatter-repeat-add`（毎日・平日・毎週・毎月・毎月末） `/saylatter-repeat-list` `/saylatter-repeat-pause` `/saylatter-repeat-test` `/saylatter-repeat-delete`

**グッジョブ**
- `/goodjob` `:GOOD_JOB:` リアクション
- メッセージやユーザーを右クリック →「アプリ」→「このメッセージにGJ」「GJを送る」（ひとこと入力つき）
- `/goodjob-ranking`（累計／今月・受け取り／送り） `/goodjob-status` `/goodjob-history`

**その他**
- `/gif-random` `/gif-category` `/random-katakana` `/dice` `/anonymous` `/activity-save` `/activity-check` `/purge` `/version`
- 管理: `/state-export` `/state-import` `/backup-status` `/backup-now`
