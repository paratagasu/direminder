# Node.jsのバージョン（index.jsは最新構文を使用しているので、Node 20が望ましい）
FROM node:20

# 作業ディレクトリを /app に設定
WORKDIR /app

# アプリのファイルをコンテナにコピー（index.jsはルートにあるため直接コピー）
COPY . .

# 依存関係のインストール
RUN npm install

# 使用するポート番号（index.jsでPORTが環境変数または3000なのでそれに合わせる）
EXPOSE 3000

# アプリの起動コマンド（index.jsを使用）
CMD ["node", "index.js"]