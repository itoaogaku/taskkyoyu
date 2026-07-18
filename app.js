/* ===== タスク管理 SPA ロジック ===== */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var PRIORITIES = CFG.PRIORITIES || [
    { key: 'l', label: 'L', color: '#34c759' },
    { key: 's', label: 'S', color: '#ff3b30' },
    { key: 'kan', label: '監', color: '#af52de' },
    { key: 'p1', label: '1', color: '#ff9500' },
    { key: 'p2', label: '2', color: '#007aff' },
    { key: 'cho', label: '長', color: '#30b0c7' },
    { key: 'ie', label: '家', color: '#5856d6' },
    { key: 'm', label: 'M', color: '#8e8e93' }
  ];
  var DEFAULT_PRIORITY = CFG.DEFAULT_PRIORITY || (PRIORITIES[0] && PRIORITIES[0].key) || 's';
  // 旧優先度キー → 新キーの読み替え（過去データ対応）
  var LEGACY_PRIORITY = { high: 's', mid: 'p2', low: 'ie', p3: 'ie' };
  var ASSIGNEE_STORE = 'assignee_options_v1';
  var OUTBOX_STORE = 'task_outbox_v1';   // 未送信タスク（通信失敗時も端末に保持）
  var CACHE_STORE = 'task_cache_v1';     // 前回の一覧データ（起動時に即表示するため）

  // 保管の繰り返し設定（none=登録のみ / monthly=毎月 / yearly=毎年）
  var REPEAT_LABELS = { none: '登録', monthly: '毎月', yearly: '毎年' };
  var REPEAT_ORDER = ['none', 'monthly', 'yearly'];
  function normalizeRepeat(v) { return (v === 'monthly' || v === 'yearly') ? v : 'none'; }
  function nextRepeat(v) {
    var i = REPEAT_ORDER.indexOf(normalizeRepeat(v));
    return REPEAT_ORDER[(i + 1) % REPEAT_ORDER.length];
  }

  // 日時文字列を比較用の数値(ミリ秒)へ。英語表記(Wed Jul 15 ...)も yyyy/MM/dd 表記も解釈
  function parseDateMs(s) {
    s = String(s == null ? '' : s);
    if (!s) return 0;
    var m = s.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
    var d = new Date(s);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }

  // 日時を日本語表記へ（例: 2026年7月15日 06:00）。英語表記(Wed Jul 15 ...)も解釈する
  function fmtDateTimeJa(s) {
    s = String(s == null ? '' : s);
    if (!s) return '';
    var p = function (n) { return ('0' + n).slice(-2); };
    var m = s.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})[ T](\d{1,2}):(\d{2})/);
    if (m) return (+m[1]) + '年' + (+m[2]) + '月' + (+m[3]) + '日 ' + p(m[4]) + ':' + m[5];
    var d = new Date(s);
    if (!isNaN(d.getTime())) {
      return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
        p(d.getHours()) + ':' + p(d.getMinutes());
    }
    return s;
  }

  // ---- 状態 ----
  var state = {
    tasks: [],
    archive: [],
    memos: [],
    view: 'open',                 // 'open' | 'done' | 'settings' | 'archive' | 'memo'
    expanded: {},                 // 展開中の項目ID（再描画をまたいで開いたままにする）
    ready: false,                 // 初回読み込みが終わったか（読み込み中は入力UIを隠す）
    composerOpen: false,          // 入力ドックを開いているか（false=丸ボタンのみ）
    composerPriority: DEFAULT_PRIORITY,
    composerAssignees: [],        // 追加フォームで選択中の確認対象者
    composerRepeat: 'none',       // 保管入力時の繰り返し設定
    assigneeOptions: loadLegacyAssignees()  // 起動直後の暫定表示。読み込み後にサーバー値で置換
  };

  // ---- DOM 参照 ----
  var $list = document.getElementById('taskList');
  var $empty = document.getElementById('emptyState');
  var $dock = document.getElementById('dock');
  var $composer = document.getElementById('composer');
  var $titleInput = document.getElementById('titleInput');
  var $prioBtn = document.getElementById('prioBtn');
  var $composerTags = document.getElementById('composerTags');
  var $archiveBtn = document.getElementById('archiveBtn');
  var $archiveDateInput = document.getElementById('archiveDateInput');
  var $repeatBtn = document.getElementById('repeatBtn');
  var $fab = document.getElementById('fab');
  var $closeFab = document.getElementById('closeFab');
  var $composerBackdrop = document.getElementById('composerBackdrop');
  var $toast = document.getElementById('toast');

  // ================= 確認対象者リスト（スプレッドシートで共有） =================
  // 旧バージョンの端末内リスト（または初期プリセット）。サーバー未登録のときの移行元。
  function loadLegacyAssignees() {
    try {
      var s = localStorage.getItem(ASSIGNEE_STORE);
      if (s) { var a = JSON.parse(s); if (Array.isArray(a) && a.length) return a; }
    } catch (e) { /* noop */ }
    return (CFG.ASSIGNEE_PRESETS || []).slice();
  }
  // 確認先リストをサーバー（スプレッドシート）へ保存し、端末をまたいで共有する
  function saveAssignees() {
    loading(true);
    api('setAssignees', { names: state.assigneeOptions.slice() }).then(function (d) {
      if (d && d.assignees) { state.assigneeOptions = d.assignees; buildComposerTags(); render(); }
    }).catch(function (e) {
      toast('確認先の保存に失敗: ' + e.message);
    }).finally(function () { loading(false); });
  }

  // ================= API =================
  function api(action, payload) {
    payload = payload || {};
    payload.action = action;
    payload.token = CFG.TOKEN;

    if (action === 'list') {
      var url = CFG.API_URL + '?action=list&token=' + encodeURIComponent(CFG.TOKEN);
      return fetch(url, { method: 'GET' }).then(parseRes);
    }
    return fetch(CFG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(parseRes);
  }

  function parseRes(res) {
    return res.text().then(function (t) {
      var data;
      try { data = JSON.parse(t); } catch (e) { throw new Error('サーバー応答が不正です'); }
      if (!data.ok) throw new Error(data.error || '不明なエラー');
      return data.data;
    });
  }

  // ================= ローディング / トースト =================
  var loadingCount = 0, $bar = null;
  function loading(on) {
    loadingCount += on ? 1 : -1;
    if (loadingCount < 0) loadingCount = 0;
    if (!$bar) {
      $bar = document.createElement('div');
      $bar.className = 'loading-bar';
      document.body.appendChild($bar);
    }
    $bar.style.width = loadingCount > 0 ? '80%' : '0';
    $bar.style.opacity = loadingCount > 0 ? '1' : '0';
  }

  var toastTimer;
  function toast(msg) {
    $toast.textContent = msg;
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $toast.hidden = true; }, 2200);
  }

  // 「取り消す」スナックバー
  var $undo = null, undoCurrentId = null;
  function showUndoBar(id, message, onUndo) {
    if (!$undo) {
      $undo = document.createElement('div');
      $undo.className = 'undo-bar';
      document.body.appendChild($undo);
    }
    undoCurrentId = id;
    $undo.innerHTML = '';
    var span = document.createElement('span');
    span.textContent = message;
    var btn = document.createElement('button');
    btn.className = 'undo-btn';
    btn.textContent = '取り消す';
    btn.addEventListener('click', function () { undoCurrentId = null; $undo.classList.remove('show'); onUndo(); });
    $undo.appendChild(span);
    $undo.appendChild(btn);
    $undo.classList.add('show');
  }
  function hideUndoBar(id) {
    if ($undo && (id === undefined || undoCurrentId === id)) {
      $undo.classList.remove('show');
      undoCurrentId = null;
    }
  }

  // ================= 優先度ユーティリティ =================
  function prioIndexOf(key) {
    for (var i = 0; i < PRIORITIES.length; i++) if (PRIORITIES[i].key === key) return i;
    return -1;
  }
  function prioMeta(key) {
    var idx = prioIndexOf(key);
    if (idx < 0 && LEGACY_PRIORITY[key]) idx = prioIndexOf(LEGACY_PRIORITY[key]);
    if (idx < 0) return { label: key || '?', color: '#8e8e93', index: PRIORITIES.length };
    var p = PRIORITIES[idx];
    return { label: p.label, color: p.color || '#8e8e93', index: idx };
  }
  function nextPriority(key) {
    var m = prioMeta(key);
    var next = m.index >= PRIORITIES.length ? 0 : (m.index + 1) % PRIORITIES.length;
    return PRIORITIES[next].key;
  }
  function parseAssignees(str) {
    if (!str) return [];
    return str.split(/\s+/).filter(Boolean);
  }

  // 確認先の並び順（確認先タブの順）。複数なら最上位、未設定は末尾。
  function assigneeRank(t) {
    var names = parseAssignees(t.assignees);
    if (!names.length) return 100000;
    var min = 100000;
    names.forEach(function (n) {
      var i = state.assigneeOptions.indexOf(n);
      if (i < 0) i = 10000; // リスト外の確認先は既知の後・未設定の前
      if (i < min) min = i;
    });
    return min;
  }

  // ================= 優先度メニュー（上に開く選択リスト） =================
  var $menuBackdrop = null, $prioMenu = null;
  function closePrioMenu() {
    if ($prioMenu) { $prioMenu.remove(); $prioMenu = null; }
    if ($menuBackdrop) { $menuBackdrop.remove(); $menuBackdrop = null; }
  }
  function openPrioMenu(anchor, currentKey, onSelect) {
    closePrioMenu();
    // 入力欄のフォーカス（キーボード）を保持するため、タップでフォーカスを奪わない
    var keepFocus = function (e) { e.preventDefault(); };
    $menuBackdrop = document.createElement('div');
    $menuBackdrop.className = 'menu-backdrop';
    $menuBackdrop.addEventListener('mousedown', keepFocus);
    $menuBackdrop.addEventListener('click', closePrioMenu);
    $prioMenu = document.createElement('div');
    $prioMenu.className = 'prio-menu';
    $prioMenu.addEventListener('mousedown', keepFocus);
    PRIORITIES.forEach(function (p) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'prio-item' + (p.key === currentKey ? ' sel' : '');
      var dot = document.createElement('span');
      dot.className = 'prio-dot';
      dot.style.background = p.color;
      var lbl = document.createElement('span');
      lbl.className = 'prio-item-label';
      lbl.textContent = p.label;
      item.appendChild(dot);
      item.appendChild(lbl);
      if (p.key === currentKey) {
        var ck = document.createElement('span');
        ck.className = 'prio-check';
        ck.textContent = '✓';
        item.appendChild(ck);
      }
      item.addEventListener('click', function () { closePrioMenu(); onSelect(p.key); });
      $prioMenu.appendChild(item);
    });
    document.body.appendChild($menuBackdrop);
    document.body.appendChild($prioMenu);
    positionMenu($prioMenu, anchor);
  }
  function positionMenu(menu, anchor) {
    // キーボード表示中（入力欄オープン）は画面左上に固定して隠れないようにする
    if (state.composerOpen) {
      var vv = window.visualViewport;
      menu.style.left = ((vv ? vv.offsetLeft : 0) + 10) + 'px';
      menu.style.top = ((vv ? vv.offsetTop : 0) + 10) + 'px';
      return;
    }
    // 通常はタップしたバッジの近くに開く（上にスペースがあれば上、なければ下）
    var r = anchor.getBoundingClientRect();
    var mh = menu.offsetHeight, mw = menu.offsetWidth;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.min(Math.max(6, r.left), vw - mw - 6);
    var top = r.top - mh - 6;                 // まず上に開く
    if (top < 6) {
      var below = r.bottom + 6;
      top = (below + mh <= vh - 6) ? below : Math.max(6, vh - mh - 6); // 上が狭ければ下に
    }
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  // ================= レンダリング =================
  function render() {
    var open = state.tasks.filter(function (t) { return t.status !== 'done'; });
    var done = state.tasks.filter(function (t) { return t.status === 'done'; });

    open.sort(function (a, b) {
      var d = prioMeta(a.priority).index - prioMeta(b.priority).index;
      if (d !== 0) return d;                     // まず優先度順
      var ra = assigneeRank(a), rb = assigneeRank(b);
      if (ra !== rb) return ra - rb;             // 次に確認先順（確認先タブの並び）
      return parseDateMs(b.createdAt) - parseDateMs(a.createdAt);
    });
    // 完了は「完了した日時」の新しい順（最新が一番上）
    done.sort(function (a, b) { return parseDateMs(b.doneAt) - parseDateMs(a.doneAt); });

    updateComposerVisibility();

    $list.innerHTML = '';

    if (state.view === 'settings') { $empty.hidden = true; renderSettings(); return; }
    if (state.view === 'archive') { $empty.hidden = true; renderArchive(); return; }
    if (state.view === 'memo') { $empty.hidden = true; renderMemo(); return; }

    function appendGroup(list) {
      var group = document.createElement('div');
      group.className = 'group';
      list.forEach(function (t) { group.appendChild(taskEl(t)); });
      $list.appendChild(group);
    }

    var rows = state.view === 'open' ? open : done;
    $empty.hidden = rows.length !== 0;

    if (state.view === 'open') {
      // M（memory）のタスクは別枠に分けて表示
      var mIndex = prioIndexOf('m');
      var mainList = open.filter(function (t) { return prioMeta(t.priority).index !== mIndex; });
      var memList = open.filter(function (t) { return prioMeta(t.priority).index === mIndex; });
      if (mainList.length) appendGroup(mainList);
      if (memList.length) {
        var div = document.createElement('div');
        div.className = 'memory-divider';
        div.innerHTML = '<span>memory</span>';
        $list.appendChild(div);
        appendGroup(memList);
      }
      return;
    }

    if (rows.length) appendGroup(rows);
  }

  // 展開の開閉を state.expanded に記録し、再描画をまたいで開いたままにする
  function bindExpand(el, main, id) {
    if (state.expanded[id]) el.classList.add('expanded');
    main.addEventListener('click', function () {
      var on = el.classList.toggle('expanded');
      if (on) state.expanded[id] = true; else delete state.expanded[id];
      updateComposerVisibility();
    });
  }

  function taskEl(t) {
    var assignees = parseAssignees(t.assignees);
    var meta = prioMeta(t.priority);
    var el = document.createElement('div');
    el.className = 'task' + (t.status === 'done' ? ' done' : '');
    el.dataset.id = t.id;

    var main = document.createElement('div');
    main.className = 'task-main';

    var badge = document.createElement('span');
    badge.className = 'badge';
    badge.style.setProperty('--c', meta.color);
    badge.textContent = meta.label;
    badge.title = '優先度を変更';
    badge.addEventListener('click', function (e) {
      e.stopPropagation();
      openPrioMenu(badge, t.priority, function (key) { setTaskPriority(t, key); });
    });

    var title = document.createElement('div');
    title.className = 'task-title';
    title.textContent = t.title;

    var doneBtn = document.createElement('button');
    doneBtn.className = 'done-btn';
    doneBtn.textContent = t.status === 'done' ? '↺' : '✓';
    doneBtn.title = t.status === 'done' ? '未完了に戻す' : '完了';
    doneBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleComplete(t); });

    main.appendChild(badge);
    main.appendChild(title);
    // 確認先（確認対象者）は完了ボタンのすぐ左に inline 表示
    if (assignees.length) {
      var ia = document.createElement('div');
      ia.className = 'task-assignees';
      assignees.forEach(function (a) {
        var c = document.createElement('span');
        c.className = 'chip';
        c.textContent = a;
        ia.appendChild(c);
      });
      main.appendChild(ia);
    }
    main.appendChild(doneBtn);
    bindExpand(el, main, t.id);
    el.appendChild(main);

    if (t.lineMemo || (t.status === 'done' && t.doneAt) || t.pending) {
      var metaRow = document.createElement('div');
      metaRow.className = 'task-meta';
      if (t.pending) {
        var pc = document.createElement('span');
        pc.className = 'pending-chip';
        pc.textContent = '未送信（通信待ち）';
        metaRow.appendChild(pc);
      }
      if (t.lineMemo) {
        var lc = document.createElement('span');
        lc.className = 'chip line';
        lc.textContent = t.lineMemo;
        metaRow.appendChild(lc);
      }
      if (t.status === 'done' && t.doneAt) {
        var dc = document.createElement('span');
        dc.className = 'done-time';
        dc.textContent = '完了 ' + fmtDateTimeJa(t.doneAt);
        metaRow.appendChild(dc);
      }
      el.appendChild(metaRow);
    }

    el.appendChild(editEl(t));
    return el;
  }

  function editEl(t) {
    var wrap = document.createElement('div');
    wrap.className = 'task-edit';

    var selected = parseAssignees(t.assignees);
    var aLabel = document.createElement('div');
    aLabel.className = 'field-label';
    aLabel.textContent = '確認対象者';
    var tagRow = document.createElement('div');
    tagRow.className = 'tag-row';
    var union = state.assigneeOptions.concat(selected.filter(function (s) { return state.assigneeOptions.indexOf(s) < 0; }));
    union.forEach(function (name) {
      var tag = document.createElement('button');
      tag.type = 'button';
      tag.className = 'tag' + (selected.indexOf(name) >= 0 ? ' on' : '');
      tag.textContent = name;
      tag.addEventListener('click', function () {
        var i = selected.indexOf(name);
        if (i >= 0) { selected.splice(i, 1); tag.classList.remove('on'); }
        else { selected.push(name); tag.classList.add('on'); }
        // 「保存」ボタンでまとめて確定するため、ここでは保存しない
      });
      tagRow.appendChild(tag);
    });

    var lLabel = document.createElement('div');
    lLabel.className = 'field-label';
    lLabel.textContent = '詳細';
    var memo = document.createElement('textarea');
    memo.className = 'memo';
    memo.placeholder = '詳細メモ（自由記入）';
    memo.value = t.lineMemo || '';

    // 保存ボタン（確認先・詳細をまとめて確定）
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'save-btn';
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', function () {
      var changed = {};
      var newAssignees = selected.join(' ');
      if (newAssignees !== (t.assignees || '')) changed.assignees = newAssignees;
      if (memo.value !== (t.lineMemo || '')) changed.lineMemo = memo.value;
      delete state.expanded[t.id]; // 保存したらこの項目は閉じる
      if (Object.keys(changed).length) {
        saveField(t, changed); // 保存後は再描画でパネルが閉じる
      } else {
        var host = wrap.closest ? wrap.closest('.task') : null;
        if (host) host.classList.remove('expanded');
      }
      toast('保存しました');
    });

    var actions = document.createElement('div');
    actions.className = 'edit-actions';
    var editTitleBtn = document.createElement('button');
    editTitleBtn.type = 'button';
    editTitleBtn.className = 'text-btn';
    editTitleBtn.textContent = 'タイトル編集';
    editTitleBtn.addEventListener('click', function () {
      var nv = prompt('タスク名を編集', t.title);
      if (nv != null && nv.trim() && nv.trim() !== t.title) saveField(t, { title: nv.trim() });
    });
    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'text-btn danger';
    delBtn.textContent = '削除';
    delBtn.addEventListener('click', function () {
      if (confirm('このタスクを削除しますか？')) removeTask(t);
    });
    actions.appendChild(editTitleBtn);
    actions.appendChild(delBtn);

    wrap.appendChild(aLabel);
    wrap.appendChild(tagRow);
    wrap.appendChild(lLabel);
    wrap.appendChild(memo);
    wrap.appendChild(saveBtn);
    wrap.appendChild(actions);
    return wrap;
  }

  // ================= 確認先タブ（確認対象者の管理） =================
  function renderSettings() {
    var card = document.createElement('div');
    card.className = 'recur-form';

    var hint = document.createElement('div');
    hint.className = 'field-label';
    hint.textContent = '確認対象者を追加・削除できます。ここの相手はタスク編集や入力時に選べます。';
    card.appendChild(hint);

    var row = document.createElement('div');
    row.className = 'recur-row';
    var input = document.createElement('input');
    input.className = 'composer-input';
    input.placeholder = '名前を入力（例: 山田課長）';
    var add = document.createElement('button');
    add.type = 'button';
    add.className = 'seg on';
    add.textContent = '追加';
    function doAdd() {
      var v = input.value.trim();
      if (!v) return;
      if (state.assigneeOptions.indexOf(v) < 0) { state.assigneeOptions.push(v); saveAssignees(); buildComposerTags(); }
      input.value = '';
      render();
    }
    add.addEventListener('click', doAdd);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
    row.appendChild(input);
    row.appendChild(add);
    card.appendChild(row);
    $list.appendChild(card);

    if (!state.assigneeOptions.length) return;
    var group = document.createElement('div');
    group.className = 'group';
    $list.appendChild(group);
    state.assigneeOptions.forEach(function (name) {
      var el = document.createElement('div');
      el.className = 'task';
      var main = document.createElement('div');
      main.className = 'task-main';
      var title = document.createElement('div');
      title.className = 'task-title';
      title.textContent = name;
      var del = document.createElement('button');
      del.className = 'done-btn';
      del.style.background = 'var(--muted)';
      del.textContent = '×';
      del.title = '削除';
      del.addEventListener('click', function () {
        state.assigneeOptions = state.assigneeOptions.filter(function (x) { return x !== name; });
        saveAssignees(); buildComposerTags(); render();
      });
      main.appendChild(title);
      main.appendChild(del);
      el.appendChild(main);
      group.appendChild(el);
    });
  }

  // ================= 保管（スクロールカレンダー 1/1〜12/31・年をまたいで統合） =================
  // 日付文字列を {y,m,d} に解釈（yyyy/MM/dd 表記も英語表記(Sat Jul 18 2026)も対応）
  function parseYMD(createdAt) {
    var s = String(createdAt || '');
    var m = s.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    if (m) return { y: +m[1], m: +m[2], d: +m[3] };
    var dt = new Date(s);
    if (!isNaN(dt.getTime())) return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
    return null;
  }
  var p2_ = function (n) { return ('0' + n).slice(-2); };
  function mmddKey(createdAt) { // 'MM/dd'（不明は末尾に来るよう '99/99'）
    var v = parseYMD(createdAt);
    return v ? (p2_(v.m) + '/' + p2_(v.d)) : '99/99';
  }
  function fmtMMDD(createdAt) { // -> 'M月D日'
    var v = parseYMD(createdAt);
    return v ? (v.m + '月' + v.d + '日') : '日付不明';
  }
  function toDateInputValue(createdAt) { // -> 'yyyy-MM-dd'
    var v = parseYMD(createdAt);
    return v ? (v.y + '-' + p2_(v.m) + '-' + p2_(v.d)) : '';
  }
  // 日時を 'yyyy/MM/dd HH:mm:ss' に正規化（英語表記等が入っても揃える）
  function normDateTime(s) {
    var v = parseYMD(s);
    var str = String(s || '');
    var t = str.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (v) return v.y + '/' + p2_(v.m) + '/' + p2_(v.d) + ' ' + (t ? (p2_(+t[1]) + ':' + t[2] + ':' + p2_(t[3] || 0)) : '00:00:00');
    var d = new Date(str);
    if (!isNaN(d.getTime())) return d.getFullYear() + '/' + p2_(d.getMonth() + 1) + '/' + p2_(d.getDate()) + ' ' + p2_(d.getHours()) + ':' + p2_(d.getMinutes()) + ':' + p2_(d.getSeconds());
    return nowLocal();
  }

  function renderArchive() {
    if (!state.archive.length) {
      var none = document.createElement('div');
      none.className = 'empty';
      none.textContent = '保管された記録はありません。タスク入力欄で「保管」を押すとここに残ります。';
      $list.appendChild(none);
      return;
    }
    // 月日（MM/dd）で並べ替え：1/1 → 12/31。同じ日付内は新しい順。
    var entries = state.archive.slice().sort(function (a, b) {
      var ka = mmddKey(a.createdAt), kb = mmddKey(b.createdAt);
      if (ka !== kb) return ka < kb ? -1 : 1;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });

    var lastKey = null, group = null;
    entries.forEach(function (e) {
      var key = mmddKey(e.createdAt);
      if (key !== lastKey) {
        var dh = document.createElement('div');
        dh.className = 'arch-day';
        dh.textContent = fmtMMDD(e.createdAt);
        $list.appendChild(dh);
        group = document.createElement('div');
        group.className = 'group';
        $list.appendChild(group);
        lastKey = key;
      }
      group.appendChild(archiveEntryEl(e));
    });
  }

  function archiveEntryEl(e) {
    var meta = prioMeta(e.priority);
    var assignees = parseAssignees(e.assignees);
    var el = document.createElement('div');
    el.className = 'task';

    var main = document.createElement('div');
    main.className = 'task-main';

    var badge = document.createElement('span');
    badge.className = 'badge';
    badge.style.setProperty('--c', meta.color);
    badge.textContent = meta.label;
    badge.title = '優先度を変更';
    badge.addEventListener('click', function (ev) {
      ev.stopPropagation();
      openPrioMenu(badge, e.priority, function (key) { saveArchiveFields(e, { priority: key }); });
    });

    var text = document.createElement('div');
    text.className = 'task-title';
    text.textContent = e.text;

    // 繰り返し設定の表示（毎月/毎年のみ）
    var rep = normalizeRepeat(e.repeat);
    if (rep !== 'none') {
      var repTag = document.createElement('span');
      repTag.className = 'repeat-tag';
      repTag.textContent = REPEAT_LABELS[rep];
      text.appendChild(repTag);
    }
    if (e.pending) {
      var pc = document.createElement('span');
      pc.className = 'pending-chip';
      pc.textContent = '未送信';
      text.appendChild(pc);
    }

    // 日付変更（タップで日付ピッカー）
    var dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'arch-date';
    dateInput.value = toDateInputValue(e.createdAt);
    dateInput.title = '日付を変更';
    dateInput.addEventListener('click', function (ev) { ev.stopPropagation(); });
    dateInput.addEventListener('change', function () {
      if (!dateInput.value) return;
      var time = normDateTime(e.createdAt).slice(11, 16) || '00:00';
      saveArchiveFields(e, { createdAt: normDateTime(dateInput.value.replace(/-/g, '/') + ' ' + time) });
    });

    var del = document.createElement('button');
    del.className = 'done-btn';
    del.style.background = 'var(--muted)';
    del.textContent = '×';
    del.title = '記録を削除';
    del.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (confirm('この記録を削除しますか？')) removeArchive(e);
    });

    main.appendChild(badge);
    main.appendChild(text);
    main.appendChild(dateInput);
    main.appendChild(del);
    bindExpand(el, main, e.id);
    el.appendChild(main);

    if (assignees.length) {
      var metaRow = document.createElement('div');
      metaRow.className = 'task-meta';
      assignees.forEach(function (a) {
        var c = document.createElement('span');
        c.className = 'chip';
        c.textContent = a;
        metaRow.appendChild(c);
      });
      el.appendChild(metaRow);
    }

    el.appendChild(archiveEditEl(e));
    return el;
  }

  function archiveEditEl(e) {
    var wrap = document.createElement('div');
    wrap.className = 'task-edit';

    var tLabel = document.createElement('div');
    tLabel.className = 'field-label';
    tLabel.textContent = '内容';
    var textInput = document.createElement('input');
    textInput.className = 'composer-input';
    textInput.value = e.text || '';

    var aLabel = document.createElement('div');
    aLabel.className = 'field-label';
    aLabel.textContent = '確認対象者';
    var selected = parseAssignees(e.assignees);
    var tagRow = document.createElement('div');
    tagRow.className = 'tag-row';
    var union = state.assigneeOptions.concat(selected.filter(function (s) { return state.assigneeOptions.indexOf(s) < 0; }));
    union.forEach(function (name) {
      var tag = document.createElement('button');
      tag.type = 'button';
      tag.className = 'tag' + (selected.indexOf(name) >= 0 ? ' on' : '');
      tag.textContent = name;
      tag.addEventListener('click', function () {
        var i = selected.indexOf(name);
        if (i >= 0) { selected.splice(i, 1); tag.classList.remove('on'); }
        else { selected.push(name); tag.classList.add('on'); }
      });
      tagRow.appendChild(tag);
    });

    // 繰り返し設定（1回のみ / 毎月 / 毎年）
    var rLabel = document.createElement('div');
    rLabel.className = 'field-label';
    rLabel.textContent = '繰り返し（この日付になると自動でタスクに追加）';
    var rRow = document.createElement('div');
    rRow.className = 'tag-row';
    var curRepeat = normalizeRepeat(e.repeat);
    var repeatSegs = {};
    REPEAT_ORDER.forEach(function (key) {
      var seg = document.createElement('button');
      seg.type = 'button';
      seg.className = 'seg' + (key === curRepeat ? ' on' : '');
      seg.textContent = REPEAT_LABELS[key];
      seg.addEventListener('click', function () {
        curRepeat = key;
        REPEAT_ORDER.forEach(function (k) { repeatSegs[k].className = 'seg' + (k === key ? ' on' : ''); });
      });
      repeatSegs[key] = seg;
      rRow.appendChild(seg);
    });

    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'save-btn';
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', function () {
      var changed = {};
      var nt = textInput.value.trim();
      if (nt && nt !== (e.text || '')) changed.text = nt;
      var na = selected.join(' ');
      if (na !== (e.assignees || '')) changed.assignees = na;
      if (curRepeat !== normalizeRepeat(e.repeat)) changed.repeat = curRepeat;
      delete state.expanded[e.id]; // 保存したらこの項目は閉じる
      if (Object.keys(changed).length) saveArchiveFields(e, changed);
      else { var host = wrap.closest ? wrap.closest('.task') : null; if (host) host.classList.remove('expanded'); }
      toast('保存しました');
    });

    wrap.appendChild(tLabel);
    wrap.appendChild(textInput);
    wrap.appendChild(aLabel);
    wrap.appendChild(tagRow);
    wrap.appendChild(rLabel);
    wrap.appendChild(rRow);
    wrap.appendChild(saveBtn);
    return wrap;
  }

  function saveArchiveFields(e, fields) {
    if (e.pending) { toast('通信待ちです。送信後に変更できます'); render(); return; }
    var prev = {};
    Object.keys(fields).forEach(function (k) { prev[k] = e[k]; e[k] = fields[k]; });
    render();
    var payload = { id: e.id };
    Object.keys(fields).forEach(function (k) { payload[k] = fields[k]; });
    loading(true);
    api('updateArchive', payload).then(function (d) {
      if (d && d.archive) state.archive = d.archive;
      if (d && d.tasks) state.tasks = d.tasks;
      render();
    }).catch(function (err) {
      Object.keys(prev).forEach(function (k) { e[k] = prev[k]; });
      render();
      toast('保存に失敗: ' + err.message);
    }).finally(function () { loading(false); });
  }

  function addArchive(text, createdAt, repeat) {
    var item = {
      id: clientId(), type: 'archive', text: text, priority: state.composerPriority,
      assignees: state.composerAssignees.join(' '), createdAt: normDateTime(createdAt || nowLocal()),
      repeat: normalizeRepeat(repeat)
    };
    outboxAdd(item);                // まず端末に保存（通信が悪くても消えない）
    state.archive.unshift(outboxToArchive(item));
    if (state.view === 'archive') render();
    toast('保管しました');
    flushOutbox();
  }

  function removeArchive(e) {
    // 未送信の保管はサーバーへ送らず、端末のキューごと削除
    if (e.pending) {
      state.archive = state.archive.filter(function (x) { return x.id !== e.id; });
      outboxRemove(e.id);
      render();
      return;
    }
    var backup = state.archive.slice();
    state.archive = state.archive.filter(function (x) { return x.id !== e.id; });
    render();
    loading(true);
    api('deleteArchive', { id: e.id }).catch(function (err) {
      state.archive = backup;
      render();
      toast('削除失敗: ' + err.message);
    }).finally(function () { loading(false); });
  }

  // ================= メモ（自由記入のメモ帳） =================
  function renderMemo() {
    // 上部：ささっと書ける入力欄（常時表示）
    var card = document.createElement('div');
    card.className = 'recur-form';

    var ta = document.createElement('textarea');
    ta.className = 'memo memo-quick';
    ta.placeholder = 'ここにメモをささっと入力…';
    card.appendChild(ta);

    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'recur-add';
    addBtn.textContent = '＋ メモを追加';
    addBtn.addEventListener('click', function () {
      var text = ta.value.trim();
      if (!text) { toast('メモを入力してください'); return; }
      addMemo(text);
      ta.value = '';
    });
    card.appendChild(addBtn);
    $list.appendChild(card);

    if (!state.memos.length) {
      var none = document.createElement('div');
      none.className = 'empty';
      none.style.padding = '24px 8px';
      none.textContent = 'メモはまだありません';
      $list.appendChild(none);
      return;
    }

    // 新しい順に表示
    var memos = state.memos.slice().sort(function (a, b) {
      return parseDateMs(b.createdAt) - parseDateMs(a.createdAt);
    });
    var group = document.createElement('div');
    group.className = 'group';
    $list.appendChild(group);
    memos.forEach(function (m) { group.appendChild(memoEl(m)); });
  }

  function memoEl(m) {
    var el = document.createElement('div');
    el.className = 'task';

    var main = document.createElement('div');
    main.className = 'task-main';

    var body = document.createElement('div');
    body.className = 'task-title memo-text';
    body.textContent = m.text;

    var del = document.createElement('button');
    del.className = 'done-btn';
    del.style.background = 'var(--muted)';
    del.textContent = '×';
    del.title = 'メモを削除';
    del.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (confirm('このメモを削除しますか？')) removeMemo(m);
    });

    main.appendChild(body);
    main.appendChild(del);
    bindExpand(el, main, m.id);
    el.appendChild(main);

    var when = document.createElement('div');
    when.className = 'task-meta';
    if (m.pending) {
      var pc = document.createElement('span');
      pc.className = 'pending-chip';
      pc.textContent = '未送信';
      when.appendChild(pc);
    }
    var dc = document.createElement('span');
    dc.className = 'done-time';
    dc.textContent = fmtDateTimeJa(m.createdAt);
    when.appendChild(dc);
    el.appendChild(when);

    // 編集パネル
    var wrap = document.createElement('div');
    wrap.className = 'task-edit';
    var ta = document.createElement('textarea');
    ta.className = 'memo memo-edit';
    ta.value = m.text || '';
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'save-btn';
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', function () {
      var nt = ta.value.trim();
      delete state.expanded[m.id]; // 保存したらこの項目は閉じる
      if (nt && nt !== (m.text || '')) updateMemo(m, nt);
      else { el.classList.remove('expanded'); }
      toast('保存しました');
    });
    wrap.appendChild(ta);
    wrap.appendChild(saveBtn);
    el.appendChild(wrap);

    return el;
  }

  function addMemo(text) {
    var item = { id: clientId(), type: 'memo', text: text, createdAt: nowLocal() };
    outboxAdd(item);                // まず端末に保存（通信が悪くても消えない）
    state.memos.unshift(outboxToMemo(item));
    render();
    toast('メモを追加しました');
    flushOutbox();
  }

  function updateMemo(m, text) {
    if (m.pending) { toast('通信待ちです。送信後に変更できます'); return; }
    var prev = m.text;
    m.text = text;
    render();
    loading(true);
    api('updateMemo', { id: m.id, text: text }).then(function (d) {
      if (d && d.memos) state.memos = d.memos;
      render();
    }).catch(function (e) {
      m.text = prev;
      render();
      toast('保存失敗: ' + e.message);
    }).finally(function () { loading(false); });
  }

  function removeMemo(m) {
    // 未送信メモはサーバーへ送らず、端末のキューごと削除
    if (m.pending) {
      state.memos = state.memos.filter(function (x) { return x.id !== m.id; });
      outboxRemove(m.id);
      render();
      return;
    }
    var backup = state.memos.slice();
    state.memos = state.memos.filter(function (x) { return x.id !== m.id; });
    render();
    loading(true);
    api('deleteMemo', { id: m.id }).catch(function (e) {
      state.memos = backup;
      render();
      toast('削除失敗: ' + e.message);
    }).finally(function () { loading(false); });
  }

  // ================= 操作（楽観的更新） =================
  // 一覧データ（tasks/archive/memos）を state へ適用し、未送信タスクを先頭に復元する
  function applyListData(d) {
    var tasks = (d && d.tasks) || [];
    var archive = (d && d.archive) || [];
    var memos = (d && d.memos) || [];
    // サーバーに既に届いている分（送信済み）はキューから除去
    var serverIds = {};
    tasks.forEach(function (t) { serverIds[t.id] = true; });
    archive.forEach(function (a) { serverIds[a.id] = true; });
    memos.forEach(function (m) { serverIds[m.id] = true; });
    var outbox = loadOutbox().filter(function (x) { return !serverIds[x.id]; });
    saveOutbox(outbox);
    // 種類ごとに未送信分を先頭に復元
    var isType = function (t) { return function (x) { return (x.type || 'task') === t; }; };
    state.tasks = outbox.filter(isType('task')).map(outboxToTask).concat(tasks);
    state.memos = outbox.filter(isType('memo')).map(outboxToMemo).concat(memos);
    state.archive = outbox.filter(isType('archive')).map(outboxToArchive).concat(archive);
  }

  function loadCache() {
    try { var s = localStorage.getItem(CACHE_STORE); if (s) return JSON.parse(s); } catch (e) { /* noop */ }
    return null;
  }
  function saveCache(d) {
    try {
      localStorage.setItem(CACHE_STORE, JSON.stringify({
        tasks: (d && d.tasks) || [],
        archive: (d && d.archive) || [],
        memos: (d && d.memos) || [],
        assignees: (d && d.assignees) || []
      }));
    } catch (e) { /* noop */ }
  }

  function load() {
    // 1) 前回のキャッシュがあれば即表示（体感を速く）。裏で最新を取得して差し替える。
    var cached = loadCache();
    if (cached) {
      applyListData(cached);
      if ((cached.assignees || []).length) state.assigneeOptions = cached.assignees;
      buildComposerTags();
      state.ready = true;
      render();
    }

    // 2) バックグラウンドで最新を取得
    loading(true);
    api('list').then(function (d) {
      applyListData(d);
      var serverAssignees = (d && d.assignees) || [];
      if (serverAssignees.length) {
        state.assigneeOptions = serverAssignees;
      } else {
        // サーバー未登録：この端末の既存リスト（または初期プリセット）を初回移行して保存
        var seed = loadLegacyAssignees();
        state.assigneeOptions = seed;
        if (seed.length) saveAssignees();
      }
      buildComposerTags();
      saveCache(d);         // 最新をキャッシュ（次回起動で即表示）
      render();
    }).catch(function (e) {
      if (!cached) toast('読み込み失敗: ' + e.message); // キャッシュ表示中は黙って継続
    }).finally(function () {
      loading(false);
      state.ready = true;   // 読み込み完了（失敗時も）後に入力UIを表示
      render();
      flushOutbox();        // 未送信タスクがあれば再送を試みる
    });
  }

  // ---- 未送信タスク（アウトボックス）----
  // 入力した瞬間に端末へ保存し、送信は自動リトライ。通信が悪くても内容を失わない。
  function loadOutbox() {
    try {
      var s = localStorage.getItem(OUTBOX_STORE);
      if (s) { var a = JSON.parse(s); if (Array.isArray(a)) return a; }
    } catch (e) { /* noop */ }
    return [];
  }
  function saveOutbox(list) {
    try { localStorage.setItem(OUTBOX_STORE, JSON.stringify(list)); } catch (e) { /* noop */ }
  }
  function clientId() {
    return 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }
  function outboxAdd(item) { var ob = loadOutbox(); ob.push(item); saveOutbox(ob); }
  function outboxRemove(id) { saveOutbox(loadOutbox().filter(function (x) { return x.id !== id; })); }
  function findIdx(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return i; return -1; }

  // 未送信アイテム → 各一覧に表示するための楽観オブジェクト（pending 付き）
  function outboxToTask(item) {
    return {
      id: item.id, title: item.title, priority: item.priority, status: 'open',
      assignees: item.assignees || '', lineMemo: '',
      createdAt: item.createdAt, doneAt: '', updatedAt: '', pending: true
    };
  }
  function outboxToMemo(item) {
    return { id: item.id, text: item.text, createdAt: item.createdAt, updatedAt: '', pending: true };
  }
  function outboxToArchive(item) {
    return {
      id: item.id, text: item.text, priority: item.priority, assignees: item.assignees || '',
      createdAt: item.createdAt, repeat: normalizeRepeat(item.repeat), lastFired: '', pending: true
    };
  }

  function addTask(title) {
    var item = {
      id: clientId(), type: 'task', title: title, priority: state.composerPriority,
      assignees: state.composerAssignees.join(' '), createdAt: nowLocal()
    };
    outboxAdd(item);                // まず端末に保存（ここで内容は確定的に残る）
    state.tasks.unshift(outboxToTask(item));
    render();
    flushOutbox();                  // 送信を試みる（失敗しても消えない）
  }

  var flushing = false, flushTimer = null;
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () { flushTimer = null; flushOutbox(); }, 15000);
  }
  // 未送信キューを先頭から順に送信。失敗したら残して後で再送。種類ごとに送り先を切替。
  function flushOutbox() {
    if (flushing) return;
    var outbox = loadOutbox();
    if (!outbox.length) return;
    flushing = true;
    var item = outbox[0];
    var type = item.type || 'task';
    var action, payload;
    if (type === 'memo') {
      action = 'addMemo'; payload = { id: item.id, text: item.text };
    } else if (type === 'archive') {
      action = 'addArchive';
      payload = { id: item.id, text: item.text, priority: item.priority, assignees: item.assignees, createdAt: item.createdAt, repeat: item.repeat };
    } else {
      action = 'add'; payload = { id: item.id, title: item.title, priority: item.priority, assignees: item.assignees };
    }
    api(action, payload).then(function (d) {
      applyFlushSuccess(type, item, d);
      outboxRemove(item.id);
      flushing = false;
      render();
      if (loadOutbox().length) flushOutbox();     // 続けて次を送信
    }).catch(function (e) {
      flushing = false;
      scheduleFlush();                            // 送れなかった。後でまた試す
    });
  }
  // 送信成功時、該当アイテムの pending を解除（サーバーの値で置換）
  function applyFlushSuccess(type, item, d) {
    if (type === 'memo') {
      var i = findIdx(state.memos, item.id), real = d && d.memo;
      if (i >= 0) { if (real) state.memos[i] = real; else state.memos[i].pending = false; }
      else if (real) state.memos.unshift(real);
    } else if (type === 'archive') {
      var j = findIdx(state.archive, item.id), re = d && d.entry;
      if (j >= 0) { if (re) state.archive[j] = re; else state.archive[j].pending = false; }
      else if (re) state.archive.unshift(re);
      // 保管が当日等で自動タスク化された分を取り込む（既存・未送信は消さない）
      if (d && d.tasks) {
        var have = {}; state.tasks.forEach(function (t) { have[t.id] = true; });
        d.tasks.forEach(function (t) { if (!have[t.id]) state.tasks.push(t); });
      }
    } else {
      var k = findIdx(state.tasks, item.id), rt = d && d.task;
      if (k >= 0) { if (rt) state.tasks[k] = rt; else state.tasks[k].pending = false; }
      else if (rt) state.tasks.unshift(rt);
    }
  }

  var completeTimers = {}; // id -> timer（確定待ちの完了）

  function toggleComplete(t) {
    if (t.pending) { toast('通信待ちです。送信後に完了できます'); return; }
    if (t.status !== 'done') { completeTask(t); return; }

    // 完了 → 未完了に戻す
    if (completeTimers[t.id]) {
      // まだ確定前ならサーバーへ送らずに取り消し
      clearTimeout(completeTimers[t.id]);
      delete completeTimers[t.id];
      hideUndoBar(t.id);
      t.status = 'open'; t.doneAt = ''; render();
      return;
    }
    t.status = 'open'; t.doneAt = ''; render();
    loading(true);
    api('uncomplete', { id: t.id }).then(function (d) {
      mergeTask(d.task);
    }).catch(function (e) {
      t.status = 'done'; t.doneAt = nowLocal(); render();
      toast('更新失敗: ' + e.message);
    }).finally(function () { loading(false); });
  }

  // 完了：画面上は即完了にし、約2秒「取り消す」を表示。その間に取り消せば保存しない。
  function completeTask(t) {
    t.status = 'done';
    t.doneAt = nowLocal();
    render();

    if (completeTimers[t.id]) clearTimeout(completeTimers[t.id]);

    showUndoBar(t.id, '完了にしました', function () {
      clearTimeout(completeTimers[t.id]);
      delete completeTimers[t.id];
      t.status = 'open'; t.doneAt = ''; render();
    });

    completeTimers[t.id] = setTimeout(function () {
      delete completeTimers[t.id];
      hideUndoBar(t.id);
      loading(true);
      api('complete', { id: t.id }).then(function (d) {
        mergeTask(d.task);
      }).catch(function (e) {
        t.status = 'open'; t.doneAt = ''; render();
        toast('更新失敗: ' + e.message);
      }).finally(function () { loading(false); });
    }, 1500);
  }

  function setTaskPriority(t, key) {
    if (key === t.priority) return;
    var prev = t.priority;
    saveField(t, { priority: key }, function () { t.priority = prev; render(); });
  }

  function saveField(t, fields, onError) {
    if (t.pending) { toast('通信待ちです。送信後に変更できます'); if (onError) onError(); return; }
    Object.keys(fields).forEach(function (k) { t[k] = fields[k]; });
    render();
    var payload = { id: t.id };
    Object.keys(fields).forEach(function (k) { payload[k] = fields[k]; });
    loading(true);
    api('update', payload).then(function (d) {
      mergeTask(d.task);
    }).catch(function (e) {
      toast('保存失敗: ' + e.message);
      if (onError) onError();
    }).finally(function () { loading(false); });
  }

  function removeTask(t) {
    // 未送信タスクはサーバーへ送らず、端末のキューごと削除
    if (t.pending) {
      state.tasks = state.tasks.filter(function (x) { return x.id !== t.id; });
      saveOutbox(loadOutbox().filter(function (x) { return x.id !== t.id; }));
      render();
      return;
    }
    var backup = state.tasks.slice();
    state.tasks = state.tasks.filter(function (x) { return x.id !== t.id; });
    render();
    loading(true);
    api('delete', { id: t.id }).catch(function (e) {
      state.tasks = backup;
      render();
      toast('削除失敗: ' + e.message);
    }).finally(function () { loading(false); });
  }

  function mergeTask(task) {
    if (!task) return;
    var idx = state.tasks.map(function (x) { return x.id; }).indexOf(task.id);
    if (idx >= 0) state.tasks[idx] = task; else state.tasks.unshift(task);
    render();
  }

  function nowLocal() {
    var d = new Date(), p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // ================= 入力バー / タブ =================
  function updatePrioBtn() {
    var m = prioMeta(state.composerPriority);
    $prioBtn.textContent = m.label;
    $prioBtn.style.setProperty('--c', m.color);
  }

  // 入力ドックの開閉（タスク/完了タブでのみ丸ボタン⇄入力欄）
  function updateComposerVisibility() {
    // 初回読み込みが終わるまでは入力UI（丸＋・入力ドック）を一切出さない
    // 完了タブでは入力(丸＋)は出さない
    var canCompose = state.ready && (state.view === 'open' || state.view === 'archive');
    var anyExpanded = !!$list.querySelector('.task.expanded');
    $dock.style.display = (canCompose && state.composerOpen) ? '' : 'none';
    // 項目を開いている時は丸ボタンを隠す
    $fab.style.display = (canCompose && !state.composerOpen && !anyExpanded) ? '' : 'none';
    // 背景は覆わない（入力を開いたままでも裏の一覧をスクロール・操作できる）。
    // 閉じるのは「閉じる」ボタンから。
    // 保管タブでは「保管専用」入力。保管ボタンは隠し、日付選択・繰り返し設定を出す
    var isArchive = state.view === 'archive';
    $archiveBtn.style.display = isArchive ? 'none' : '';
    $archiveDateInput.style.display = isArchive ? '' : 'none';
    $repeatBtn.style.display = isArchive ? '' : 'none';
    if (isArchive && !$archiveDateInput.value) $archiveDateInput.value = toDateInputValue(nowLocal());
    updateRepeatBtn();
    $titleInput.placeholder = isArchive ? '記録を保管…（毎年/毎月で自動タスク化）' : 'タスクを入力して追加…';
  }
  function updateRepeatBtn() {
    $repeatBtn.textContent = REPEAT_LABELS[normalizeRepeat(state.composerRepeat)];
    $repeatBtn.classList.toggle('on', state.composerRepeat !== 'none');
  }
  // アプリの高さをビジュアルビューポート（キーボードを除いた表示領域）に合わせる。
  // これで入力ドックが常にキーボードの直上に収まり、裏の一覧は内部スクロールできる。
  // アプリを、実際に見えている領域（キーボードを除いたビジュアルビューポート）に
  // ぴったり合わせる。高さ=vv.height、位置=vv.offsetTop（iOSのフォーカス時ずれを打ち消す）。
  var lastH = -1, lastTop = -1;
  function setAppHeight() {
    var vv = window.visualViewport;
    var h = Math.round(vv ? vv.height : window.innerHeight);
    var top = Math.round(vv ? vv.offsetTop : 0);
    if (h !== lastH) { lastH = h; document.documentElement.style.setProperty('--app-h', h + 'px'); }
    if (top !== lastTop) { lastTop = top; document.documentElement.style.setProperty('--app-top', top + 'px'); }
  }
  function openComposer() {
    state.composerOpen = true;
    updateComposerVisibility();
    $titleInput.focus();
  }
  function closeComposer() {
    state.composerOpen = false;
    if (document.activeElement) document.activeElement.blur();
    updateComposerVisibility();
  }

  function buildComposerTags() {
    $composerTags.innerHTML = '';
    state.assigneeOptions.forEach(function (name) {
      var tag = document.createElement('button');
      tag.type = 'button';
      tag.className = 'tag' + (state.composerAssignees.indexOf(name) >= 0 ? ' on' : '');
      tag.textContent = name;
      function toggle() {
        var i = state.composerAssignees.indexOf(name);
        if (i >= 0) { state.composerAssignees.splice(i, 1); tag.classList.remove('on'); }
        else { state.composerAssignees.push(name); tag.classList.add('on'); }
        // 入力欄のフォーカス（キーボード）を維持する
        if (state.composerOpen && document.activeElement !== $titleInput) $titleInput.focus();
      }
      // タップとスクロールを区別。タップ時は touchend で既定動作(フォーカス移動)を
      // 止めることで、iOS でもキーボードを閉じずに選択できる。
      var sx = 0, sy = 0, moved = false, handled = false;
      tag.addEventListener('touchstart', function (e) {
        var t = e.touches[0]; sx = t.clientX; sy = t.clientY; moved = false; handled = false;
      }, { passive: true });
      tag.addEventListener('touchmove', function (e) {
        var t = e.touches[0];
        if (Math.abs(t.clientX - sx) > 8 || Math.abs(t.clientY - sy) > 8) moved = true;
      }, { passive: true });
      tag.addEventListener('touchend', function (e) {
        handled = true;
        if (moved) return;      // 横スクロール操作 → 選択しない
        e.preventDefault();     // タップ → キーボードを閉じない（click も抑止）
        toggle();
      });
      tag.addEventListener('mousedown', function (e) { e.preventDefault(); }); // PC: フォーカス維持
      tag.addEventListener('click', function () {
        if (handled) { handled = false; return; } // タッチで処理済み
        toggle();
      });
      $composerTags.appendChild(tag);
    });
  }

  function bindEvents() {
    // タップで入力欄のフォーカス（キーボード）を失わないようにする
    $prioBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    $prioBtn.addEventListener('click', function () {
      openPrioMenu($prioBtn, state.composerPriority, function (key) {
        state.composerPriority = key;
        updatePrioBtn();
      });
    });

    $composer.addEventListener('submit', function (e) {
      e.preventDefault();
      var title = $titleInput.value.trim();
      if (!title) return;
      if (state.view === 'archive') {
        var created;
        if ($archiveDateInput.value) {
          created = $archiveDateInput.value.replace(/-/g, '/') + ' ' + nowLocal().slice(11, 16);
        }
        addArchive(title, created, state.composerRepeat); // 選択した日付・繰り返しで保管
      } else {
        addTask(title);
      }
      $titleInput.value = '';
      $titleInput.focus();
    });

    $archiveBtn.addEventListener('click', function () {
      var text = $titleInput.value.trim();
      if (!text) { toast('保管する内容を入力してください'); return; }
      addTask(text);      // タスクとして追加
      addArchive(text);   // 同じ内容を保管にも格納
      $titleInput.value = '';
      $titleInput.focus();
    });

    $repeatBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    $repeatBtn.addEventListener('click', function () {
      state.composerRepeat = nextRepeat(state.composerRepeat);
      updateRepeatBtn();
    });

    // 日付を選び終わったら文字キーボードを戻す（続けて入力できるように）。
    // ※iOSでは日付ピッカーと文字キーボードは同時に出せない仕様のため、選択中は一旦閉じる。
    $archiveDateInput.addEventListener('change', function () {
      if (state.view === 'archive' && state.composerOpen) $titleInput.focus();
    });

    $fab.addEventListener('click', openComposer);
    $closeFab.addEventListener('click', closeComposer);
    $composerBackdrop.addEventListener('click', closeComposer);

    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('is-active'); });
        tab.classList.add('is-active');
        state.view = tab.dataset.view;
        state.composerOpen = false;
        render();
      });
    });

    document.getElementById('reloadBtn').addEventListener('click', load);

    // キーボード開閉(resize)・iOSのフォーカス時ずれ(scroll)にアプリを合わせる
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', setAppHeight);
      window.visualViewport.addEventListener('scroll', setAppHeight);
    }
    window.addEventListener('orientationchange', function () { setTimeout(setAppHeight, 150); });

    // 一覧内の入力欄（詳細メモ・確認先追加・メモ編集など）にフォーカスしたら、
    // キーボードに隠れないよう見える位置までスクロールする（固定レイアウトでは
    // iOSの自動スクロールが効かないため自前で行う）
    $list.addEventListener('focusin', function (e) {
      var t = e.target;
      if (!t || (t.tagName !== 'TEXTAREA' && t.tagName !== 'INPUT')) return;
      // タスクを編集中は、そのタスクのタイトルごと見えるよう先頭に寄せる。
      // それ以外（メモ/確認先）は対象欄を中央に。
      var task = t.closest ? t.closest('.task') : null;
      var target = task || t;
      var block = task ? 'start' : 'center';
      setTimeout(function () {
        try { target.scrollIntoView({ block: block, behavior: 'smooth' }); }
        catch (_) { target.scrollIntoView(); }
      }, 300); // キーボード表示・アプリ高さ調整の後にスクロール
    });

    // 通信が復帰したら未送信タスクを自動で再送
    window.addEventListener('online', flushOutbox);
    // 画面に戻ってきた（アプリ復帰）ときも再送を試みる
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) flushOutbox();
    });
  }

  // ================= 起動 =================
  function init() {
    if (!CFG.API_URL || CFG.API_URL.indexOf('PASTE_YOUR') === 0) {
      toast('config.js に GAS の URL を設定してください');
    }
    buildComposerTags();
    updatePrioBtn();
    bindEvents();
    setAppHeight();             // アプリ高さをビューポートに合わせる
    updateComposerVisibility(); // 読み込み前に入力UIを隠しておく（丸＋/−の同時表示を防ぐ）
    load();
  }

  init();
})();
