// ===== アプリ設定 =====
// このアプリは複数人で同じ画面(同じVercelデプロイ)を使い、各自が自分の
// GASウェブアプリ(スプレッドシート)への接続をアプリ内の「接続設定」画面で
// 登録する方式です。そのため API_URL / TOKEN はここには書きません
// （書いてもよいですが、公開ファイルなので全利用者に見えてしまいます）。
// 各自の接続先は、初回起動時の設定画面 → 端末(ブラウザ)内にのみ保存されます。
window.APP_CONFIG = {
  // 確認対象者の初期プリセット（アプリの「確認先」タブで自由に追加・削除できます）。
  ASSIGNEE_PRESETS: ['上司', '先輩', 'チームA', 'チームB', '顧客', '自分'],

  // 優先度の定義（配列の上から順に優先度が高い＝並び順もこの順）。
  // key: 内部値 / label: 表示 / color: バッジ色
  PRIORITIES: [
    { key: 'l',  label: 'L', color: '#34c759' },
    { key: 's',  label: 'S', color: '#ff3b30' },
    { key: 'kan', label: '監', color: '#af52de' },
    { key: 'p1', label: '1', color: '#ff9500' },
    { key: 'p2', label: '2', color: '#007aff' },
    { key: 'cho', label: '長', color: '#30b0c7' },
    { key: 'ie',  label: '家', color: '#5856d6' },
    { key: 'm',  label: 'M', color: '#8e8e93' }
  ],

  // 新規タスクの初期優先度（key）。
  DEFAULT_PRIORITY: 'p1'
};
