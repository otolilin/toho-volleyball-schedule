# 部活カレンダー（Vercel版）

## 構成
- `public/index.html` … 画面
- `api/data.js` … サーバー側（パスワード判定・データ保存）。依存パッケージなし

## 公開の3段階
- 誰でも: 練習日と時間のみ
- 部員（部員パスコード）: 自分の回答と日ごとの人数集計
- 管理者（管理者パスワード）: 全員の出欠・理由、練習日と名簿の編集

## デプロイ手順
1. このフォルダをGitHubにpush（または `npx vercel` で直接デプロイ）
2. Vercelでプロジェクトをインポート（Framework Preset は「Other」、設定は変更不要）
3. プロジェクトの Storage タブ → Marketplace から **Upstash Redis（無料枠）** を作成して接続
   （環境変数 `KV_REST_API_URL` / `KV_REST_API_TOKEN` などが自動で入ります）
4. Settings → Environment Variables に次の2つを追加
   - `ADMIN_PASSWORD` … 管理者パスワード（長めに）
   - `MEMBER_CODE` … 部員に共有するパスコード
5. Redeploy（環境変数を追加した後は再デプロイが必要）

## 運用メモ
- 部員パスコードを知っている人は他の部員の名前で回答できます。パスコードは部員だけに共有し、漏れたら環境変数を変えて再デプロイしてください
- 名簿は本名でなくニックネームでも動きます
