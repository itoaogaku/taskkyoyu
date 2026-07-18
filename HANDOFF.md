# 引き継ぎ資料（タスク管理アプリ）

このドキュメントは、本システムを別の担当者（Claude Code 利用者）へ引き継ぐための要点をまとめたものです。
まずこれを読めば、構成・セットアップ・デプロイ・開発の進め方が分かります。

---

## 1. これは何か

スマホ（iPhone）ファーストのタスク管理 Web アプリ。

```
[iPhone ブラウザ / ホーム画面PWA]  ⇄  [GAS ウェブアプリ (API)]  ⇄  [Google スプレッドシート (DB)]
                     ↑
        [Vercel] が静的ホスティング(main を自動デプロイ)
```

- **フロント**：HTML + Vanilla JS + CSS（ビルド不要の SPA）。Vercel に静的ホスティング。
- **バックエンド**：Google Apps Script（GAS）ウェブアプリ。スプレッドシートと読み書きを中継。
- **DB**：Google スプレッドシート（シート＝テーブル）。

リポジトリ：**`itoaogaku/task`**（GitHub）。デプロイは `main` ブランチ基準。

---

## 2. リポジトリ構成

| ファイル / フォルダ | 役割 |
| --- | --- |
| `index.html` | 画面の骨組み（タブ、一覧、入力ドック、FAB）＋PWA/アイコンのメタ |
| `app.js` | フロントのロジック全部（状態管理・描画・API通信・オフライン処理・iOSキーボード対応） |
| `styles.css` | スタイル（iOS風・ダーク/ライト対応・アクセント緑 `#068c89`） |
| `config.js` | **設定**：GASのURL(`API_URL`)・トークン(`TOKEN`)・優先度定義・確認先プリセット |
| `gas/Code.gs` | **バックエンド**（GASに貼り付けて使うコード。リポジトリのはソース管理用） |
| `vercel.json` | Vercel 設定（cleanUrls・セキュリティヘッダ） |
| `manifest.webmanifest` / `icon*.png` / `icon.svg` / `apple-touch-icon.png` | PWA（ホーム画面追加で全画面化）用 |
| `widget/scriptable-widget.js` | iPhoneホーム画面ウィジェット（Scriptableアプリ用）。`widget/README.md` に手順 |
| `README.md` | ⚠️ 初期版の説明で**内容が古い**（優先度high/mid/lowなど旧仕様）。本 HANDOFF を正とする |

---

## 3. 設定値（どこを見るか）

- **フロント設定**：`config.js`
  - `API_URL` … GAS ウェブアプリの `/exec` URL
  - `TOKEN` … 簡易アクセストークン（GAS 側 `SHARED_TOKEN` と一致必須）
  - `PRIORITIES` … 優先度の定義（キー/表示/色）。現在8種：`l(L) / s(S) / kan(監) / p1(1) / p2(2) / cho(長) / ie(家) / m(M)`
  - `DEFAULT_PRIORITY` … 既定優先度（`p1`）
  - `ASSIGNEE_PRESETS` … 確認先の初期候補（実データはスプレッドシートで共有管理）
- **バックエンド設定**：`gas/Code.gs` 冒頭
  - `SHARED_TOKEN` … `config.js` の `TOKEN` と同じ値にする
  - `TIMEZONE` … `Asia/Tokyo`

> トークンはURLに載る簡易認証です。個人利用向けの割り切り。強化したい場合は要検討。

---

## 4. データモデル（スプレッドシートのシート＝テーブル）

初回アクセス時に GAS が各シートとヘッダーを自動生成します。

- **Tasks**：`id, title, priority, status(open/done), assignees, lineMemo, createdAt, doneAt, updatedAt`
- **Archive**（保管）：`id, text, priority, assignees, createdAt, repeat(none/monthly/yearly), lastFired`
- **Memo**（メモ）：`id, text, createdAt, updatedAt`
- **Assignees**（確認先）：`name`（1列。端末をまたいで共有）

日時は `yyyy/MM/dd HH:mm:ss`（JST）。
※ 旧「Recurring（定期）」シートは廃止済み。残っていれば削除してOK（GASに `removeRecurringSheet()` あり）。

---

## 5. 主な機能

- **タスク**：追加／完了（1.5秒“取り消す”付き）／優先度バッジ切替／確認先・詳細メモ編集／`M`は「memory」枠に区切り表示
- **保管**：日付＋繰り返し（登録/毎月/毎年）で記録。毎月・毎年はその日付になると自動でタスク化（保管データは消えない）
- **メモ**：自由記入のメモ帳
- **確認先**：確認対象者リストの管理（スプレッドシートで共有）
- **完了**：完了日時の新しい順
- **表示**：ダーク/ライト自動、全画面PWA、上部トースト、「未送信」表示 等

---

## 6. 重要な実装ポイント（ハマりどころ）

- **CORS回避**：POSTは `text/plain` の“シンプルリクエスト”でGASへ送る（プリフライト回避）。`app.js` の `api()` 参照。
- **起動高速化（キャッシュ先読み）**：前回データを `localStorage(task_cache_v1)` に保存し、起動時に即表示 → 裏で最新取得して差し替え（GASが遅いため体感対策）。
- **未送信キュー（オフライン対応）**：追加(タスク/メモ/保管)は `localStorage(task_outbox_v1)` に即保存 → 自動再送。各追加に**クライアント生成ID**を付与し、GAS側を**冪等化**（同じIDは二重追加しない）。「未送信」表示・自動リトライあり。
  - ⚠️ **重要**：この冪等化は **GAS を再デプロイして初めて有効**になる。未反映のままオフライン再送を使うと、応答喪失時などに**同じタスクが複製**される（`addTask_`/`addMemo_`/`addArchive_` が `params.id` を使い、`findRow(Obj)_` で既存IDを重複追加しない設計）。**Code.gs を変えたら必ず再デプロイ**すること。
- **iOSキーボード対応**：`.app` を `position:fixed` で `visualViewport` の高さ(`--app-h`)・位置(`--app-top`)に合わせる。一覧は内部スクロール。これで入力欄がキーボード直上に固定され、裏の一覧もスクロールできる。**iOS特有で壊れやすいので触るときは実機確認必須**。
- **展開状態の保持**：`state.expanded` で、裏の再描画をまたいでも開いた項目が閉じない（保存時は閉じる）。
- **日付の正規化**：`normDateTime()` / `parseYMD()` で英語表記の日付も吸収（過去に混入した英語日付対策）。

---

## 7. 開発の進め方（ビルド不要）

- **ローカル確認**：リポジトリ直下で簡易サーバを立てて開くだけ。
  ```
  python3 -m http.server 5173   # → http://localhost:5173
  ```
  ※ 実データはGASに繋がる。config.js のURL/トークンが有効なら動く。
- **構文チェック**：`node --check app.js`（`Code.gs` は `.gs` 拡張のため一時的に `.js` にコピーしてチェック）
- **見た目確認**：ヘッドレスChromiumでスクショを撮って確認する運用をしている（キーボード等の実挙動は実機必須）。
- **コード規約**：素のJS（ES5寄り・`var`中心）。既存のスタイルに合わせる。外部ライブラリ・ビルドツールなし。

---

## 8. デプロイ手順

### フロント（Vercel）
`main` ブランチにpushすると**自動デプロイ**（設定済み）。特別な操作は不要。

### バックエンド（GAS）— `gas/Code.gs` を変えたときだけ手動
1. 対象スプレッドシートを開く → 拡張機能 → Apps Script
2. `Code.gs` の中身を最新（GitHub `itoaogaku/task` の `gas/Code.gs`）に**全文貼り替え**して保存
3. **デプロイ → デプロイを管理 → 編集(鉛筆) → バージョン「新バージョン」→ デプロイ**
   - 「新バージョン」で再デプロイすれば通常 `/exec` URL は不変。変わったら `config.js` の `API_URL` を更新。
4. 保管の繰り返し自動タスク化を使う場合、GASエディタで **`setupTriggers` を1回実行**（毎日1回のトリガー設定）。

> **原則：`gas/Code.gs` を編集したら再デプロイが必要**。フロント(js/css/html)だけの変更なら再デプロイ不要。

### GAS のメンテナンス用関数（エディタで関数選択→実行）
`gas/Code.gs` には手動実行用の関数がある（Webからは呼ばれない）。

| 関数 | 用途 |
| --- | --- |
| `setupTriggers` | 毎日1回のトリガー設定（保管の繰り返し自動タスク化に必要）。初回に1回 |
| `removeRecurringSheet` | 旧「Recurring（定期）」シートを削除（廃止済み機能の後片付け） |
| `dedupeTasks` | 重複タスク行の掃除。`title/priority/assignees/status` が完全一致する行を1件だけ残す。**実行前にシートのバックアップ推奨** |

> 補足：過去に冪等化未反映のまま再送テストをして「テスト」等が複製された経緯あり。再デプロイ後に `dedupeTasks` を1回実行すれば掃除できる。以後は複製されない。

---

## 9. 引き継ぎ時に渡すもの / 確認すること

1. **GitHubリポジトリ `itoaogaku/task` へのアクセス権**（またはフォーク/移管）
2. **対象の Google スプレッドシート**の編集権限（GASプロジェクトもこのスプレッドシートに紐づく）
3. **Vercel プロジェクト**の権限（`main` 自動デプロイ先）
4. `config.js` の `API_URL` / `TOKEN`、`Code.gs` の `SHARED_TOKEN` が一致していること
5. 別スプレッドシート/別環境で運用するなら：新スプレッドシートにGASを設置→新しい `/exec` URLを `config.js` に設定→Vercelに反映

---

## 10. Claude Code で続きを開発するには

- リポジトリを開き、本 `HANDOFF.md` と各ファイルを読ませれば文脈を把握できる。
- 変更→`node --check`→（必要なら）ヘッドレスでスクショ確認→コミット→push（`main`でVercel自動反映）。
- **GASを変えたら手動再デプロイ**を忘れない（§8）。
- iOSキーボード周り（`setAppHeight`/`--app-h`/`--app-top`）は実機でしか正しく確認できないので、変更時は実機スクショで検証する。

---

（このドキュメントは現行実装に基づく。仕様変更したら本ファイルも更新してください。）
