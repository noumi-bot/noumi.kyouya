/**
 * 内定者フォロー管理ダッシュボード ─ Google Apps Script Web アプリ
 * ---------------------------------------------------------------------------
 * このスクリプトを「内定者フォロー管理」スプレッドシートにバインドして
 * ウェブアプリとして公開すると、開くたびに最新のサマリを WEB 上で確認できます。
 * （データは Google の外に出ません＝個人情報はスプレッドシートと同じ管理下）
 *
 * ■ セットアップ
 *   1. 対象スプレッドシートを開く → 拡張機能 → Apps Script
 *   2. Code.gs にこの内容を貼り付け、Page.html を追加して Page.html の内容を貼り付け
 *   3. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *        - 次のユーザーとして実行: 自分
 *        - アクセスできるユーザー: 組織内（もしくは必要範囲）
 *   4. 発行された URL を開く
 *
 * ■ 仕組み（表記ゆれに強い設計）
 *   タブ名が多少変わっても動くよう、キーワードでタブを探索します。
 *   個人別の◯/－は「照合チェック（回答済）」＋「未回答リスト（未回答）」から
 *   再構成するため、集計ロジックはスプレッドシート本体と一致します。
 */

// ─────────────────────────────────────────────────────────────────────────
// エントリポイント
// ─────────────────────────────────────────────────────────────────────────
function doGet() {
  var t = HtmlService.createTemplateFromFile('Page');
  return t.evaluate()
    .setTitle('内定者フォロー管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// クライアント（Page.html）から呼び出されるメイン関数
function getDashboardData() {
  try {
    return buildDashboardData();
  } catch (err) {
    return { error: String(err && err.stack ? err.stack : err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// データ構築
// ─────────────────────────────────────────────────────────────────────────
function buildDashboardData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone() || 'Asia/Tokyo';
  var sheets = ss.getSheets();

  var diag = { sheetsFound: {} };
  var todayStr = fmtDate_(new Date(), tz);

  // --- 内定者マスタ: 氏名→メール、対象者集合 -------------------------------
  var masterSheet = findSheet_(sheets, ['内定者マスタ', 'マスタ']);
  var emailByName = {}, targetSet = {}, targetCount = 0;
  if (masterSheet) {
    diag.sheetsFound.master = masterSheet.getName();
    var m = getValues_(masterSheet);
    var mh = findHeaderRow_(m, ['氏名']);
    if (mh >= 0) {
      var cTgt = colIndex_(m[mh], ['対象']);
      var cName = colIndex_(m[mh], ['氏名']);
      var cMail = colIndex_(m[mh], ['メール']);
      for (var i = mh + 1; i < m.length; i++) {
        var nm = norm_(m[i][cName]);
        if (!nm) continue;
        if (cMail >= 0) emailByName[nm] = String(m[i][cMail] || '').trim();
        var tgtVal = cTgt >= 0 ? String(m[i][cTgt] || '').trim() : '対象';
        if (tgtVal === '対象') { targetSet[nm] = true; targetCount++; }
      }
    }
  }

  // --- フォーム一覧: フォーム定義と回答率 ----------------------------------
  var formListSheet = findSheet_(sheets, ['フォーム一覧']);
  var forms = [];
  if (formListSheet) {
    diag.sheetsFound.formList = formListSheet.getName();
    var f = getValues_(formListSheet);
    var fh = findHeaderRow_(f, ['フォーム名']);
    if (fh >= 0) {
      var H = f[fh];
      var ci = {
        tab: colIndex_(H, ['回答タブ']),
        name: colIndex_(H, ['フォーム名']),
        type: colIndex_(H, ['集計タイプ', 'タイプ']),
        due: colIndex_(H, ['期日']),
        done: colIndex_(H, ['回答済人数', '回答済']),
        not: colIndex_(H, ['未回答人数', '未回答']),
        rate: colIndex_(H, ['回答率']),
        last: colIndex_(H, ['最終回答日時', '最終回答'])
      };
      for (var r = fh + 1; r < f.length; r++) {
        var fname = norm_(f[r][ci.name]);
        if (!fname) continue;
        var due = fmtDate_(f[r][ci.due], tz);
        var done = toNum_(f[r][ci.done]);
        var notd = toNum_(f[r][ci.not]);
        var rate = ci.rate >= 0 ? parseRate_(f[r][ci.rate]) : null;
        if (rate === null && (done + notd) > 0) rate = Math.round(done / (done + notd) * 100);
        forms.push({
          name: fname,
          tab: ci.tab >= 0 ? norm_(f[r][ci.tab]) : fname,
          type: ci.type >= 0 ? norm_(f[r][ci.type]) : '',
          due: due,
          done: done,
          notdone: notd,
          rate: rate === null ? 0 : rate,
          last: ci.last >= 0 ? fmtDateTime_(f[r][ci.last], tz) : '',
          overdue: due && due < todayStr
        });
      }
    }
  }

  // フォーム名→index の索引（回答タブ名でも引けるように）
  var formIndex = {};
  forms.forEach(function (fm, idx) {
    if (fm.name) formIndex[fm.name] = idx;
    if (fm.tab) formIndex[fm.tab] = idx;
  });

  // --- 照合チェック: 回答済（氏名一致・別名一致）--------------------------
  var checkSheet = findSheet_(sheets, ['照合チェック']);
  var answered = {}; // key = masterName || form -> true
  var lastUpdated = '';
  if (checkSheet) {
    diag.sheetsFound.check = checkSheet.getName();
    var c = getValues_(checkSheet);
    lastUpdated = scanLastUpdated_(c, tz) || lastUpdated;
    var chh = findHeaderRow_(c, ['照合結果']);
    if (chh >= 0) {
      var cc = {
        form: colIndex_(c[chh], ['フォーム名']),
        tab: colIndex_(c[chh], ['回答タブ']),
        master: colIndex_(c[chh], ['マスタ氏名']),
        result: colIndex_(c[chh], ['照合結果'])
      };
      for (var k = chh + 1; k < c.length; k++) {
        var res = norm_(c[k][cc.result]);
        if (res.indexOf('一致') === -1) continue; // 氏名一致 / 別名一致 のみ回答済扱い
        var mn = norm_(c[k][cc.master]);
        if (!mn) continue;
        var fkey = resolveFormIndex_(formIndex, norm_(c[k][cc.form]), cc.tab >= 0 ? norm_(c[k][cc.tab]) : '');
        if (fkey === -1) continue;
        answered[mn + '||' + fkey] = true;
      }
    }
  }

  // --- 未回答リスト: 未回答 + リマインド判定 -------------------------------
  var pendingSheet = findSheet_(sheets, ['未回答リスト', '未回答']);
  var pending = {}; // key = name||formIdx -> judge
  if (pendingSheet) {
    diag.sheetsFound.pending = pendingSheet.getName();
    var p = getValues_(pendingSheet);
    lastUpdated = scanLastUpdated_(p, tz) || lastUpdated;
    var ph = findHeaderRow_(p, ['氏名', 'フォーム名']);
    if (ph >= 0) {
      var pc = {
        form: colIndex_(p[ph], ['フォーム名']),
        tab: colIndex_(p[ph], ['回答タブ']),
        name: colIndex_(p[ph], ['氏名']),
        mail: colIndex_(p[ph], ['メール']),
        judge: colIndex_(p[ph], ['リマインド判定', 'リマインド', '判定'])
      };
      for (var q = ph + 1; q < p.length; q++) {
        var nm2 = norm_(p[q][pc.name]);
        if (!nm2) continue;
        var fi2 = resolveFormIndex_(formIndex, norm_(p[q][pc.form]), pc.tab >= 0 ? norm_(p[q][pc.tab]) : '');
        if (fi2 === -1) continue;
        pending[nm2 + '||' + fi2] = pc.judge >= 0 ? norm_(p[q][pc.judge]) : (forms[fi2].overdue ? '期限超過' : '要リマインド');
        if (pc.mail >= 0 && !emailByName[nm2]) emailByName[nm2] = String(p[q][pc.mail] || '').trim();
      }
    }
  }

  // --- 個人別マトリクスの再構成 --------------------------------------------
  // 対象者一覧（マスタが取れなければ、回答/未回答に出てくる氏名から補完）
  var names = Object.keys(targetSet);
  if (!names.length) {
    var seen = {};
    Object.keys(answered).forEach(function (kk) { seen[kk.split('||')[0]] = true; });
    Object.keys(pending).forEach(function (kk) { seen[kk.split('||')[0]] = true; });
    names = Object.keys(seen);
    targetCount = names.length;
  }

  var people = names.map(function (nm) {
    var r = forms.map(function (_, idx) {
      if (answered[nm + '||' + idx]) return 1;
      if (pending[nm + '||' + idx]) return 0;
      return null; // 対象外（当該フォームの集計対象でない）
    });
    var req = r.filter(function (v) { return v !== null; });
    var doneCnt = req.filter(function (v) { return v === 1; }).length;
    var rate = req.length ? Math.round(doneCnt / req.length * 100) : 0;
    return { name: nm, email: emailByName[nm] || '', r: r, rate: rate };
  }).sort(function (a, b) { return b.rate - a.rate || a.name.localeCompare(b.name, 'ja'); });

  // --- 氏名別名: 有効件数 ---------------------------------------------------
  var aliasSheet = findSheet_(sheets, ['氏名別名']);
  var aliasCount = 0;
  if (aliasSheet) {
    diag.sheetsFound.alias = aliasSheet.getName();
    var a = getValues_(aliasSheet);
    var ah = findHeaderRow_(a, ['マスタ氏名']);
    if (ah >= 0) {
      var aEn = colIndex_(a[ah], ['有効']);
      for (var z = ah + 1; z < a.length; z++) {
        if (!norm_(a[z][colIndex_(a[ah], ['マスタ氏名'])])) continue;
        if (aEn < 0 || isTrue_(a[z][aEn])) aliasCount++;
      }
    }
  }

  if (!lastUpdated) lastUpdated = fmtDateTime_(new Date(), tz);

  return {
    lastUpdated: lastUpdated,
    today: todayStr,
    forms: forms,
    people: people,
    meta: {
      targetCount: targetCount,
      formCount: forms.length,
      aliasCount: aliasCount
    },
    diagnostics: diag
  };
}

// ─────────────────────────────────────────────────────────────────────────
// ヘルパー
// ─────────────────────────────────────────────────────────────────────────
function findSheet_(sheets, keywords) {
  for (var i = 0; i < sheets.length; i++) {
    var n = sheets[i].getName();
    for (var j = 0; j < keywords.length; j++) {
      if (n.indexOf(keywords[j]) !== -1) return sheets[i];
    }
  }
  return null;
}

function getValues_(sheet) {
  var rng = sheet.getDataRange();
  return rng.getValues();
}

// 指定カラム名（部分一致）をすべて含む最初の行をヘッダ行とみなす
function findHeaderRow_(rows, requiredCols) {
  var limit = Math.min(rows.length, 12);
  for (var i = 0; i < limit; i++) {
    var ok = requiredCols.every(function (col) {
      return rows[i].some(function (cell) { return norm_(cell).indexOf(col) !== -1; });
    });
    if (ok) return i;
  }
  return -1;
}

function colIndex_(headerRow, candidates) {
  for (var c = 0; c < candidates.length; c++) {
    for (var i = 0; i < headerRow.length; i++) {
      if (norm_(headerRow[i]).indexOf(candidates[c]) !== -1) return i;
    }
  }
  return -1;
}

function resolveFormIndex_(formIndex, formName, tabName) {
  if (formName && formIndex[formName] !== undefined) return formIndex[formName];
  if (tabName && formIndex[tabName] !== undefined) return formIndex[tabName];
  // 部分一致フォールバック
  var keys = Object.keys(formIndex);
  for (var i = 0; i < keys.length; i++) {
    if (formName && (keys[i].indexOf(formName) !== -1 || formName.indexOf(keys[i]) !== -1)) return formIndex[keys[i]];
  }
  return -1;
}

// 「最終更新」ラベルの隣セルから日時を拾う
function scanLastUpdated_(rows, tz) {
  for (var i = 0; i < Math.min(rows.length, 4); i++) {
    for (var j = 0; j < rows[i].length; j++) {
      if (norm_(rows[i][j]).indexOf('最終更新') !== -1) {
        var v = rows[i][j + 1];
        if (v) return fmtDateTime_(v, tz);
      }
    }
  }
  return '';
}

function norm_(v) { return String(v == null ? '' : v).trim(); }

function toNum_(v) {
  if (v === '' || v == null) return 0;
  var n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function parseRate_(v) {
  if (v === '' || v == null) return null;
  if (typeof v === 'number') return v <= 1 ? Math.round(v * 100) : Math.round(v);
  var n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : Math.round(n);
}

function isTrue_(v) {
  if (v === true) return true;
  var s = String(v).trim().toUpperCase();
  return s === 'TRUE' || s === '1' || s === '○' || s === 'YES';
}

function fmtDate_(v, tz) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  var s = norm_(v);
  // 「8/20」「2026/08/20」等をゆるく正規化
  var mAll = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (mAll) return mAll[1] + '-' + pad2_(mAll[2]) + '-' + pad2_(mAll[3]);
  return s;
}

function fmtDateTime_(v, tz) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm');
  return norm_(v);
}

function pad2_(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
