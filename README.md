# スマホ最適化タスク管理アプリ（Google スプレッドシート DB × Vercel）

Google スプレッドシートをデータベースにした、スマホファーストの高密度タスク管理 SPA です。
フロントは **HTML + Vanilla JS + CSS**（ビルド不要）で Vercel に静的ホスティング、
バックエンドは **Google Apps Script（GAS）ウェブアプリ**がスプレッドシートとの読み書きを中継します。

```
[スマホ ブラウザ (Vercel)]  ⇄  [GAS Web App API]  ⇄  [Google スプレッドシート]
```

## 機能

- タスクの高速入力（下部固定バー）＆高密度リスト表示
- 「完了」ボタン → 即「完了済み」タブへ移動し、完了日時（YYYY/MM/DD hh:mm, JST）を自動記録
- 優先度（急ぎ/通常/低）をバッジのタップで切り替え
- 確認対象者を `@上司` `@チームA` などのマークダウン風 @タグで選択・保持
- 「LINE：ここまで確認済み」専用メモ欄
- 楽観的更新でローディング待ちを最小化（サクサク動作）

---

## 1. スプレッドシートのカラム構成

初回アクセス時に GAS が `Tasks` シートとヘッダー行を自動生成します（手動作成も可）。

| 列 | カラム名 | 内容 | 例 |
|----|-----------|------|-----|
| A | `id` | タスクの一意 ID（自動生成） | `t1a2b3c...` |
| B | `title` | タスク本文 | `見積もりを送る` |
| C | `priority` | 優先度キー | `high` / `mid` / `low` |
| D | `status` | 状態 | `open` / `done` |
| E | `assignees` | 確認対象者（@タグをスペース区切り） | `@上司 @チームA` |
| F | `lineMemo` | LINE 確認済みメモ | `17:30のメッセージまで返信済み` |
| G | `createdAt` | 作成日時（JST） | `2026/07/13 09:12` |
| H | `doneAt` | 完了日時（JST。未完了は空） | `2026/07/13 18:40` |
| I | `updatedAt` | 最終更新日時（JST） | `2026/07/13 18:40` |

---

## 2. バックエンド（Google Apps Script）のセットアップ

1. タスクを保存したい Google スプレッドシートを新規作成して開く
2. メニュー **拡張機能 → Apps Script** を開く
3. `gas/Code.gs` の内容をエディタに貼り付ける
4. コード先頭の `SHARED_TOKEN` を推測されにくいランダム文字列に変更する
5. **デプロイ → 新しいデプロイ** を選択
   - 種類（歯車）: **ウェブアプリ**
   - 説明: 任意
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**
6. **デプロイ**をクリックし、承認フローを完了
7. 発行された **ウェブアプリ URL（末尾が `/exec`）** を控える

> コードを修正したら、**デプロイ → デプロイを管理 → 鉛筆アイコン → バージョン「新規」** で再デプロイしてください（URL は変わりません）。

### セキュリティについて
- `SHARED_TOKEN` により無差別なアクセスをある程度ブロックできます。ただしトークンはフロントの JS に含まれるため完全な秘匿はできません。より厳密にしたい場合は「アクセスできるユーザー」を Google アカウント限定にする、Cloudflare Workers 等で追加認証を挟む、などを検討してください。

---

## 3. フロントエンドの設定

`config.js` を編集します。

```js
window.APP_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/XXXX/exec', // ← 手順2で控えた URL
  TOKEN: 'change-me-to-a-random-string',                    // ← Code.gs の SHARED_TOKEN と同じ値
  ASSIGNEE_PRESETS: ['@上司', '@先輩', '@チームA', '@顧客', '@自分'], // 任意でカスタマイズ
  PRIORITIES: [
    { key: 'high', label: '急ぎ' },
    { key: 'mid',  label: '通常' },
    { key: 'low',  label: '低' }
  ]
};
```

### ローカルで動作確認
静的ファイルなので簡易サーバーで開けます（`file://` だと fetch が動きません）。

```bash
cd task-manager
python3 -m http.server 5173
# → http://localhost:5173 をスマホ実機やデベロッパーツールのモバイル表示で確認
```

---

## 4. Vercel へのデプロイ手順

このアプリはビルド不要の静的サイトです。`task-manager/` ディレクトリを公開します。

### 方法 A: Vercel ダッシュボード（GitHub 連携）
1. このリポジトリを GitHub に push
2. [vercel.com](https://vercel.com) にログイン → **Add New → Project** → リポジトリを Import
3. **Root Directory** に `task-manager` を指定
4. Framework Preset: **Other**（Build/Output 設定は空のままで OK）
5. **Deploy** をクリック → 発行された URL をスマホで開く

### 方法 B: Vercel CLI
```bash
npm i -g vercel
cd task-manager
vercel        # 初回。プロンプトに従う（プロジェクト作成）
vercel --prod # 本番デプロイ
```

### デプロイ後
- 発行 URL をスマホのホーム画面に追加すると、アプリのように使えます
  （Safari: 共有 → ホーム画面に追加 / Chrome: メニュー → ホーム画面に追加）。

---

## トラブルシューティング

| 症状 | 原因 / 対処 |
|------|-------------|
| `unauthorized` | `config.js` の `TOKEN` と `Code.gs` の `SHARED_TOKEN` が不一致 |
| 読み込み失敗 / CORS エラー | GAS を「アクセスできるユーザー: 全員」で**再デプロイ**しているか確認 |
| 変更が保存されない | `API_URL` が `/exec` で終わっているか確認（`/dev` は不可） |
| 完了日時がずれる | `Code.gs` の `TIMEZONE`（既定 `Asia/Tokyo`）を確認 |

## ファイル構成

```
task-manager/
├── index.html      # 画面
├── styles.css      # モバイルファースト・高密度スタイル
├── app.js          # SPA ロジック（楽観的更新・API 通信）
├── config.js       # API URL / トークン / プリセット設定
├── vercel.json     # Vercel 設定
└── gas/
    └── Code.gs     # Google Apps Script バックエンド
```
