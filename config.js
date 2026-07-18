// ===== アプリ設定 =====
// GAS ウェブアプリのデプロイ URL（末尾が /exec のもの）に置き換えてください。
window.APP_CONFIG = {
  // 例: 'https://script.google.com/macros/s/AKfy...../exec'
  // ↓ 新しい GAS ウェブアプリをデプロイして得た /exec URL に置き換えてください（別インスタンスの必須手順）。
  API_URL: 'https://script.google.com/macros/s/XXXXX_REPLACE_WITH_YOUR_NEW_GAS_EXEC_URL_XXXXX/exec',

  // GAS の Code.gs の SHARED_TOKEN と同じ値にしてください（この値で両者を合わせ済み）。
  TOKEN: 'DXSKg8eg1kiMs6ysGC5hee2sCm8a',

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
