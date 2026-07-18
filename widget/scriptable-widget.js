// ===================================================================
//  タスク管理  iPhone ホーム画面ウィジェット（Scriptable 用）
// -------------------------------------------------------------------
//  未完了タスクを優先度順にホーム画面へ表示します。
//  同じ GAS バックエンド（スプレッドシート）を読むだけなので、
//  アプリ本体と常に同じ内容になります。
//
//  【使い方】
//   1. App Store で無料アプリ「Scriptable」をインストール
//   2. Scriptable を開き、右上「＋」で新規スクリプト
//   3. このファイルの中身をすべて貼り付けて保存（名前を「タスク」等に）
//   4. ホーム画面を長押し →「＋」→ Scriptable を選択 →
//      小・中・大どれかのサイズを追加
//   5. 追加されたウィジェットを長押し →「ウィジェットを編集」→
//      Script にこのスクリプトを選択（When Interacting は「Run Script」推奨）
//
//  ※ APIのURL・トークンは公開中の config.js と同じ値です。
//     別のスプレッドシートに変えた場合はここも合わせてください。
// ===================================================================

// ===== 設定（必要なら書き換え） =====
const API_URL = 'https://script.google.com/macros/s/XXXXX_REPLACE_WITH_YOUR_NEW_GAS_EXEC_URL_XXXXX/exec';
const TOKEN   = 'DXSKg8eg1kiMs6ysGC5hee2sCm8a';
// タップで開くアプリ（Vercel）のURL（この新インスタンスの Vercel URL に置き換え）
const APP_URL = 'https://XXXXX_REPLACE_WITH_YOUR_NEW_VERCEL_URL_XXXXX.vercel.app';
// アクセントカラー（アプリと同じ緑）
const ACCENT  = '#068c89';
// 何分ごとに更新を試みるか
const REFRESH_MINUTES = 30;

// 優先度定義（アプリの config.js と同じ順・同じ色）
const PRIORITIES = [
  { key: 'l',   label: 'L', color: '#34c759' },
  { key: 's',   label: 'S', color: '#ff3b30' },
  { key: 'kan', label: '監', color: '#af52de' },
  { key: 'p1',  label: '1', color: '#ff9500' },
  { key: 'p2',  label: '2', color: '#007aff' },
  { key: 'cho', label: '長', color: '#30b0c7' },
  { key: 'ie',  label: '家', color: '#5856d6' },
  { key: 'm',   label: 'M', color: '#8e8e93' }
];
// 旧優先度キー → 新キー（過去データ対応）
const LEGACY = { high: 's', mid: 'p2', low: 'ie', p3: 'ie' };

// サイズごとの表示件数
const FAMILY = config.widgetFamily || 'large';
const MAX_ITEMS = FAMILY === 'small' ? 3 : (FAMILY === 'medium' ? 6 : 12);

// ===== 優先度ユーティリティ =====
function prioMeta(key) {
  let idx = PRIORITIES.findIndex(p => p.key === key);
  if (idx < 0 && LEGACY[key]) idx = PRIORITIES.findIndex(p => p.key === LEGACY[key]);
  if (idx < 0) return { label: key || '?', color: '#8e8e93', index: PRIORITIES.length };
  const p = PRIORITIES[idx];
  return { label: p.label, color: p.color, index: idx };
}

// ===== データ取得 =====
async function fetchTasks() {
  const url = API_URL + '?action=list&token=' + encodeURIComponent(TOKEN);
  const req = new Request(url);
  req.timeoutInterval = 20;
  const json = await req.loadJSON();
  if (!json || !json.ok) throw new Error((json && json.error) || 'API error');
  const tasks = (json.data && json.data.tasks) || [];
  const open = tasks.filter(t => t.status !== 'done');
  open.sort((a, b) => {
    const d = prioMeta(a.priority).index - prioMeta(b.priority).index;
    if (d !== 0) return d;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
  return open;
}

// ===== ウィジェット描画 =====
function makeColor(hexA, hexB) { return Color.dynamic(new Color(hexA), new Color(hexB)); }
const COL_BG    = makeColor('#ffffff', '#000000');
const COL_CARD  = makeColor('#f2f2f7', '#1c1c1e');
const COL_TEXT  = makeColor('#1c1c1e', '#ffffff');
const COL_MUTED = makeColor('#8e8e93', '#8e8e93');

function addHeader(widget, count) {
  const head = widget.addStack();
  head.centerAlignContent();
  const dot = head.addStack();
  dot.backgroundColor = new Color(ACCENT);
  dot.cornerRadius = 3;
  dot.size = new Size(10, 10);
  head.addSpacer(6);
  const title = head.addText('タスク');
  title.font = Font.boldSystemFont(14);
  title.textColor = COL_TEXT;
  head.addSpacer();
  const badge = head.addText(String(count));
  badge.font = Font.boldSystemFont(14);
  badge.textColor = new Color(ACCENT);
  widget.addSpacer(8);
}

function addTaskRow(widget, t, showAssignees) {
  const meta = prioMeta(t.priority);
  const row = widget.addStack();
  row.centerAlignContent();
  row.url = APP_URL; // 行タップでアプリを開く

  // 優先度バッジ
  const badge = row.addStack();
  badge.backgroundColor = new Color(meta.color);
  badge.cornerRadius = 4;
  badge.setPadding(1, 5, 1, 5);
  const bl = badge.addText(meta.label);
  bl.font = Font.boldSystemFont(11);
  bl.textColor = new Color('#ffffff');

  row.addSpacer(7);

  // タイトル（＋確認先）
  const title = row.addText(t.title || '');
  title.font = Font.systemFont(13);
  title.textColor = COL_TEXT;
  title.lineLimit = 1;

  if (showAssignees && t.assignees) {
    row.addSpacer(6);
    const who = row.addText(String(t.assignees).split(/\s+/).filter(Boolean).join(' '));
    who.font = Font.systemFont(11);
    who.textColor = COL_MUTED;
    who.lineLimit = 1;
  }

  row.addSpacer();
  widget.addSpacer(6);
}

function buildWidget(open) {
  const widget = new ListWidget();
  widget.backgroundColor = COL_BG;
  widget.setPadding(14, 14, 14, 14);
  widget.url = APP_URL; // 余白タップでもアプリを開く
  widget.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60 * 1000);

  addHeader(widget, open.length);

  if (!open.length) {
    const done = widget.addText('未完了のタスクはありません 🎉');
    done.font = Font.systemFont(13);
    done.textColor = COL_MUTED;
    return widget;
  }

  const showAssignees = FAMILY !== 'small';
  const items = open.slice(0, MAX_ITEMS);
  items.forEach(t => addTaskRow(widget, t, showAssignees));

  const remaining = open.length - items.length;
  if (remaining > 0) {
    widget.addSpacer(2);
    const more = widget.addText('ほか ' + remaining + ' 件');
    more.font = Font.systemFont(11);
    more.textColor = COL_MUTED;
  }
  return widget;
}

function buildErrorWidget(err) {
  const widget = new ListWidget();
  widget.backgroundColor = COL_BG;
  widget.setPadding(14, 14, 14, 14);
  widget.url = APP_URL;
  const t = widget.addText('読み込みに失敗しました');
  t.font = Font.boldSystemFont(13);
  t.textColor = COL_TEXT;
  widget.addSpacer(4);
  const m = widget.addText(String(err && err.message ? err.message : err));
  m.font = Font.systemFont(11);
  m.textColor = COL_MUTED;
  m.lineLimit = 3;
  return widget;
}

// ===== 実行 =====
let widget;
try {
  const open = await fetchTasks();
  widget = buildWidget(open);
} catch (e) {
  widget = buildErrorWidget(e);
}

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  // アプリ内で実行したときはプレビュー表示
  if (FAMILY === 'small') await widget.presentSmall();
  else if (FAMILY === 'medium') await widget.presentMedium();
  else await widget.presentLarge();
}
Script.complete();
