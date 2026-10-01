/**
 * タスク管理アプリ  Google Apps Script バックエンド
 * -------------------------------------------------
 * Googleスプレッドシートを DB として、フロントエンド(SPA)と中継する Web API。
 *
 * 【セットアップ】
 *  1. タスクを保存したい Google スプレッドシートを開く
 *  2. 拡張機能 → Apps Script を開き、このコードを貼り付ける
 *  3. 下の SHARED_TOKEN を推測されにくい文字列に変更する
 *     （アプリの接続設定画面で入力するトークンと同じ値にする）
 *  4. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *       - 実行するユーザー: 自分
 *       - アクセスできるユーザー: 全員
 *  5. 発行された /exec の URL とトークンを、アプリの接続設定画面で登録する
 *
 * シートは初回アクセス時に "Tasks" / "Archive" / "Memo" / "Assignees"
 * シートとヘッダーを自動生成します。
 *
 * 【保管の繰り返し（毎月/毎年 自動タスク化）を有効にするには】
 *  コードを貼り直したあと、エディタ上部の関数選択で「setupTriggers」を選び
 *  「実行」を1回押してください。毎日1回、保管の記録のうち今日が対象日の
 *  ものを自動でタスク一覧へ追加するトリガーが設定されます。
 */

// ===== 設定 =====
var SHEET_NAME = 'Tasks';
var ARCHIVE_SHEET = 'Archive';
var MEMO_SHEET = 'Memo';
var ASSIGNEE_SHEET = 'Assignees';
var TIMEZONE = 'Asia/Tokyo';
var DEFAULT_PRIORITY = 'p1';
// 簡易アクセストークン（アプリの接続設定画面で入力するトークンと一致させる）
var SHARED_TOKEN = 'DXSKg8eg1kiMs6ysGC5hee2sCm8a';

// 列定義（この順序でシートに保存される）
var COLUMNS = ['id', 'title', 'priority', 'status', 'assignees', 'lineMemo', 'createdAt', 'doneAt', 'updatedAt'];
var ARCHIVE_COLUMNS = ['id', 'text', 'priority', 'assignees', 'createdAt', 'repeat', 'lastFired'];
var MEMO_COLUMNS = ['id', 'text', 'createdAt', 'updatedAt'];
var ASSIGNEE_COLUMNS = ['name'];

// ===== エントリポイント =====
function doGet(e) {
  return handle_(e, (e && e.parameter) || {});
}

function doPost(e) {
  var params = {};
  try {
    if (e && e.postData && e.postData.contents) {
      params = JSON.parse(e.postData.contents);
    }
  } catch (err) {
    return json_({ ok: false, error: 'invalid JSON body' });
  }
  return handle_(e, params);
}

function handle_(e, params) {
  try {
    // トークン検証
    if (String(params.token || '') !== String(SHARED_TOKEN)) {
      return json_({ ok: false, error: 'unauthorized' });
    }

    var action = params.action || 'list';
    var result;
    switch (action) {
      case 'list':            result = listAll_(); break;
      case 'add':             result = addTask_(params); break;
      case 'update':          result = updateTask_(params); break;
      case 'complete':        result = setStatus_(params.id, 'done'); break;
      case 'uncomplete':      result = setStatus_(params.id, 'open'); break;
      case 'delete':          result = deleteTask_(params.id); break;
      case 'addArchive':      result = addArchive_(params); break;
      case 'updateArchive':   result = updateArchive_(params); break;
      case 'deleteArchive':   result = deleteArchive_(params.id); break;
      case 'addMemo':         result = addMemo_(params); break;
      case 'updateMemo':      result = updateMemo_(params); break;
      case 'deleteMemo':      result = deleteMemo_(params.id); break;
      case 'setAssignees':    result = setAssignees_(params); break;
      default:
        return json_({ ok: false, error: 'unknown action: ' + action });
    }
    return json_({ ok: true, data: result });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// ===== 各アクション =====
function listAll_() {
  return {
    tasks: readRows_(getSheet_(), COLUMNS),
    archive: readRows_(getArchiveSheet_(), ARCHIVE_COLUMNS),
    memos: readRows_(getMemoSheet_(), MEMO_COLUMNS),
    assignees: readAssignees_()
  };
}

function readRows_(sheet, cols) {
  var values = sheet.getDataRange().getValues();
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    if (!values[r][0]) continue; // id が無い行はスキップ
    rows.push(rowToObj_(values[r], cols));
  }
  return rows;
}

// 1行分の値 → 列名→文字列のオブジェクト
function rowToObj_(row, cols) {
  var obj = {};
  for (var c = 0; c < cols.length; c++) {
    var v = row[c];
    // シートが日付型に自動変換したセルは yyyy/MM/dd HH:mm:ss 文字列へ整形
    obj[cols[c]] = (v instanceof Date) ? Utilities.formatDate(v, TIMEZONE, 'yyyy/MM/dd HH:mm:ss')
                                        : (v != null ? String(v) : '');
  }
  return obj;
}

// id(1列目)で行を探す。シートを1回で読み込み、見つかれば { rowIndex(1始まり), obj } を返す
function findById_(sheet, cols, id) {
  if (!id) return null;
  var values = sheet.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]) === String(id)) return { rowIndex: r + 1, obj: rowToObj_(values[r], cols) };
  }
  return null;
}

function addTask_(params) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = getSheet_();
    // 同じIDが既にあれば二重追加しない（オフライン再送で重複を防ぐ）
    if (params.id) {
      var existing = findRow_(params.id);
      if (existing) return { task: existing.task };
    }
    var now = now_();
    var task = {
      id: params.id || generateId_(),
      title: String(params.title || '').trim(),
      priority: params.priority || DEFAULT_PRIORITY,
      status: 'open',
      assignees: String(params.assignees || ''),
      lineMemo: String(params.lineMemo || ''),
      createdAt: now,
      doneAt: '',
      updatedAt: now
    };
    if (!task.title) throw new Error('title is required');
    sheet.appendRow(COLUMNS.map(function (c) { return task[c]; }));
    return { task: task };
  } finally {
    lock.releaseLock();
  }
}

function updateTask_(params) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var loc = findRow_(params.id);
    if (!loc) throw new Error('task not found: ' + params.id);
    var sheet = loc.sheet, rowIndex = loc.rowIndex, task = loc.task;

    // 更新可能なフィールドのみ反映
    ['title', 'priority', 'assignees', 'lineMemo', 'status'].forEach(function (key) {
      if (params[key] !== undefined) task[key] = String(params[key]);
    });
    // status を done/open に切り替えた場合は doneAt を整合させる
    if (params.status !== undefined) {
      task.doneAt = params.status === 'done' ? (task.doneAt || now_()) : '';
    }
    task.updatedAt = now_();

    writeRow_(sheet, rowIndex, task);
    return { task: task };
  } finally {
    lock.releaseLock();
  }
}

function setStatus_(id, status) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var loc = findRow_(id);
    if (!loc) throw new Error('task not found: ' + id);
    var sheet = loc.sheet, rowIndex = loc.rowIndex, task = loc.task;
    task.status = status;
    task.doneAt = status === 'done' ? now_() : '';
    task.updatedAt = now_();
    writeRow_(sheet, rowIndex, task);
    return { task: task };
  } finally {
    lock.releaseLock();
  }
}

function deleteTask_(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var loc = findRow_(id);
    if (!loc) throw new Error('task not found: ' + id);
    loc.sheet.deleteRow(loc.rowIndex);
    return { id: id };
  } finally {
    lock.releaseLock();
  }
}

// ===== 保管（アーカイブ / 記録） =====
function addArchive_(params) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = getArchiveSheet_();
    var id = params.id || generateId_();
    // 冪等: 同じIDが既にあれば二重追加しない（オフライン再送対策）
    var existing = findById_(sheet, ARCHIVE_COLUMNS, id);
    if (existing) return { entry: existing.obj, newTasks: [] };
    var repeat = (params.repeat === 'monthly' || params.repeat === 'yearly') ? params.repeat : 'none';
    var entry = {
      id: id,
      text: String(params.text || '').trim(),
      priority: params.priority || DEFAULT_PRIORITY,
      assignees: String(params.assignees || ''),
      createdAt: params.createdAt ? String(params.createdAt) : now_(),
      repeat: repeat,
      lastFired: ''
    };
    if (!entry.text) throw new Error('text is required');
    sheet.appendRow(ARCHIVE_COLUMNS.map(function (c) { return entry[c]; }));
    // 記載日が本日(月日)なら即タスク化。新しくできたタスクだけ返す（一覧全体は返さない＝速い）。
    // ※ 旧版アプリは `tasks` を受け取ると一覧を丸ごと置き換えるため、別名 newTasks で返す
    return { entry: entry, newTasks: runArchiveReminders_() };
  } finally {
    lock.releaseLock();
  }
}

function updateArchive_(params) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = getArchiveSheet_();
    var hit = findById_(sheet, ARCHIVE_COLUMNS, params.id);
    if (!hit) throw new Error('archive not found: ' + params.id);
    var entry = hit.obj;
    ['text', 'priority', 'assignees', 'createdAt'].forEach(function (k) {
      if (params[k] !== undefined) entry[k] = String(params[k]);
    });
    if (params.repeat !== undefined) {
      entry.repeat = (params.repeat === 'monthly' || params.repeat === 'yearly') ? params.repeat : 'none';
    }
    // 日付や繰り返し設定を変えたら、発火状態をリセット
    if (params.createdAt !== undefined || params.repeat !== undefined) entry.lastFired = '';
    sheet.getRange(hit.rowIndex, 1, 1, ARCHIVE_COLUMNS.length)
         .setValues([ARCHIVE_COLUMNS.map(function (col) { return entry[col]; })]);
    return { entry: entry, newTasks: runArchiveReminders_() };
  } finally {
    lock.releaseLock();
  }
}

function deleteArchive_(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = getArchiveSheet_();
    var hit = findById_(sheet, ARCHIVE_COLUMNS, id);
    if (!hit) throw new Error('archive not found: ' + id);
    sheet.deleteRow(hit.rowIndex);
    return { id: id };
  } finally {
    lock.releaseLock();
  }
}

// ===== メモ（自由記入のメモ帳） =====
function addMemo_(params) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = getMemoSheet_();
    var id = params.id || generateId_();
    // 冪等: 同じIDが既にあれば二重追加しない（オフライン再送対策）
    var existing = findById_(sheet, MEMO_COLUMNS, id);
    if (existing) return { memo: existing.obj };
    var now = now_();
    var memo = {
      id: id,
      text: String(params.text || '').trim(),
      createdAt: now,
      updatedAt: now
    };
    if (!memo.text) throw new Error('text is required');
    sheet.appendRow(MEMO_COLUMNS.map(function (c) { return memo[c]; }));
    return { memo: memo };
  } finally {
    lock.releaseLock();
  }
}

function updateMemo_(params) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = getMemoSheet_();
    var hit = findById_(sheet, MEMO_COLUMNS, params.id);
    if (!hit) throw new Error('memo not found: ' + params.id);
    var memo = hit.obj;
    if (params.text !== undefined) memo.text = String(params.text);
    memo.updatedAt = now_();
    sheet.getRange(hit.rowIndex, 1, 1, MEMO_COLUMNS.length)
         .setValues([MEMO_COLUMNS.map(function (col) { return memo[col]; })]);
    return { memo: memo };
  } finally {
    lock.releaseLock();
  }
}

function deleteMemo_(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = getMemoSheet_();
    var hit = findById_(sheet, MEMO_COLUMNS, id);
    if (!hit) throw new Error('memo not found: ' + id);
    sheet.deleteRow(hit.rowIndex);
    return { id: id };
  } finally {
    lock.releaseLock();
  }
}

// ===== 確認先（確認対象者リスト・端末をまたいで共有） =====
function readAssignees_() {
  var sheet = getAssigneeSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var vals = sheet.getRange(2, 1, last - 1, 1).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var n = vals[i][0];
    if (n != null && String(n).trim() !== '') out.push(String(n));
  }
  return out;
}

// 確認先リストをまるごと上書き保存（順序を保持・重複と空を除去）
function setAssignees_(params) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var names = params.names;
    if (!Array.isArray(names)) {
      try { names = JSON.parse(names); } catch (e) { names = []; }
    }
    if (!Array.isArray(names)) names = [];
    var clean = [];
    for (var i = 0; i < names.length; i++) {
      var n = String(names[i] == null ? '' : names[i]).trim();
      if (n && clean.indexOf(n) < 0) clean.push(n);
    }
    var sheet = getAssigneeSheet_();
    sheet.clearContents();
    sheet.getRange(1, 1).setValue('name');
    if (clean.length) {
      sheet.getRange(2, 1, clean.length, 1).setValues(clean.map(function (n) { return [n]; }));
    }
    sheet.setFrozenRows(1);
    return { assignees: clean };
  } finally {
    lock.releaseLock();
  }
}

// 毎日1回のトリガーから呼ばれるエントリポイント（保管の繰り返しリマインダー）
// ※ 関数名は既存トリガーが参照しているため変更しない
function runRecurring() {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    runArchiveReminders_();
  } finally {
    lock.releaseLock();
  }
}

// 保管の各記録を繰り返し設定に応じてタスク化する（保管データは消さない・同日に二重発火しない）
//   repeat = 'yearly'  … 毎年その月日にタスク化
//   repeat = 'monthly' … 毎月その日にタスク化
//   repeat = 'none'    … タスク化しない（保管のみ）
// 戻り値：新しくタスク化したタスクの配列
function runArchiveReminders_() {
  var newTasks = [];
  var sheet = getArchiveSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return newTasks;
  var today = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy/MM/dd');
  var todayMMDD = today.slice(5);   // MM/dd
  var todayDD = today.slice(8);     // dd
  var values = sheet.getRange(2, 1, last - 1, ARCHIVE_COLUMNS.length).getValues();
  var idx = {};
  ARCHIVE_COLUMNS.forEach(function (c, i) { idx[c] = i; });

  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    if (!row[idx.id]) continue;
    var repeat = String(row[idx.repeat] || 'none');
    if (repeat !== 'monthly' && repeat !== 'yearly') continue; // 保管のみ
    var created = String(row[idx.createdAt] || '');
    if (repeat === 'yearly') {
      if (created.slice(5, 10) !== todayMMDD) continue;  // 月日が今日でない
    } else { // monthly
      if (created.slice(8, 10) !== todayDD) continue;    // 日が今日でない
    }
    if (String(row[idx.lastFired] || '') === today) continue; // 本日は発火済み

    var now = now_();
    var task = {
      id: generateId_(), title: String(row[idx.text] || ''),
      priority: String(row[idx.priority] || '') || DEFAULT_PRIORITY,
      status: 'open', assignees: String(row[idx.assignees] || ''), lineMemo: '',
      createdAt: now, doneAt: '', updatedAt: now
    };
    if (!task.title) continue;
    getSheet_().appendRow(COLUMNS.map(function (c) { return task[c]; }));
    sheet.getRange(r + 2, idx.lastFired + 1).setValue(today); // 本日発火済みに
    newTasks.push(task);
  }
  return newTasks;
}

// 毎日1回のトリガーを設定（GASエディタから1回だけ手動実行する）
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runRecurring') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runRecurring').timeBased().everyDays(1).atHour(6).create();
}

// 旧「定期」機能で使っていた Recurring シートを削除してスプレッドシートを整理する。
// エディタ上部の関数選択で「removeRecurringSheet」を選び「実行」を1回押すと消えます。
function removeRecurringSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Recurring');
  if (sheet) ss.deleteSheet(sheet);
}

// タスクの重複行を除去する（同じ title/priority/assignees/status を1件に）。
// エディタ上部の関数選択で「dedupeTasks」を選び「実行」を1回押すと掃除されます。
// ※ 内容・状態が完全一致する行のみ削除し、最初の1件を残します。実行前にシートのバックアップ推奨。
function dedupeTasks() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet_();
    var last = sheet.getLastRow();
    if (last < 3) return 0;
    var vals = sheet.getRange(2, 1, last - 1, COLUMNS.length).getValues();
    var idx = {}; COLUMNS.forEach(function (c, i) { idx[c] = i; });
    var seen = {}, toDelete = [];
    for (var r = 0; r < vals.length; r++) {
      var row = vals[r];
      if (!row[idx.id]) continue;
      var key = [row[idx.title], row[idx.priority], row[idx.assignees], row[idx.status]].join('');
      if (seen[key]) toDelete.push(r + 2); // 2行目始まり
      else seen[key] = true;
    }
    toDelete.sort(function (a, b) { return b - a; }); // 下から削除
    toDelete.forEach(function (rn) { sheet.deleteRow(rn); });
    Logger.log('dedupeTasks: 削除 ' + toDelete.length + ' 行');
    return toDelete.length;
  } finally {
    lock.releaseLock();
  }
}

// ===== ヘルパー =====
function getSheet_() {
  return ensureSheet_(SHEET_NAME, COLUMNS);
}

function getArchiveSheet_() {
  return ensureSheet_(ARCHIVE_SHEET, ARCHIVE_COLUMNS);
}

function getMemoSheet_() {
  return ensureSheet_(MEMO_SHEET, MEMO_COLUMNS);
}

function getAssigneeSheet_() {
  return ensureSheet_(ASSIGNEE_SHEET, ASSIGNEE_COLUMNS);
}

// 1回のリクエストの中ではスプレッドシート・シートの取得を使い回す
// （スプレッドシートへの問い合わせ回数を減らすと応答が速くなる）
var ss_ = null, sheetCache_ = {};
function ensureSheet_(name, cols) {
  if (sheetCache_[name]) return sheetCache_[name];
  if (!ss_) ss_ = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss_.getSheetByName(name);
  if (!sheet) sheet = ss_.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(cols);
    sheet.setFrozenRows(1);
  }
  sheetCache_[name] = sheet;
  return sheet;
}

function findRow_(id) {
  var sheet = getSheet_();
  var hit = findById_(sheet, COLUMNS, id);
  return hit ? { sheet: sheet, rowIndex: hit.rowIndex, task: hit.obj } : null;
}

function writeRow_(sheet, rowIndex, task) {
  sheet.getRange(rowIndex, 1, 1, COLUMNS.length)
       .setValues([COLUMNS.map(function (c) { return task[c]; })]);
}

function now_() {
  return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy/MM/dd HH:mm:ss');
}

function generateId_() {
  return 't' + new Date().getTime().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
