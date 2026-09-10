/**************************************************************************************************
 * 面談フィードバック自動化（Plaud文字起こし → 8軸採点 → 個別FBメール → 傾向ログ）
 * ------------------------------------------------------------------------------------------------
 * 使い方の段階（経路の最終決定を待たずに実戦投入できます）
 *   Step0: sendTestReport()      … APIキー不要。サンプルFBが noumi@ に届く。体裁確認用。
 *   Step1: 文字起こしJSONをDriveに置く → runMeetingFbBatch()  … 半自動（今日から可）
 *   Step2: ブリッジで「Plaud→Drive自動書き出し」を接続し、15〜30分トリガーで全自動
 *
 * 事前準備
 *   1) スクリプト プロパティに ANTHROPIC_API_KEY を登録
 *   2) CONFIG.MODEL を利用可能なモデルIDに合わせる（採点はSonnet系で十分・低コスト）
 *   3) CONFIG.LOG_SHEET_ID は設定済み（下記）。対象シートが無ければ初回実行時に自動生成。
 *   4) CONFIG.WATCH_FOLDER_ID に監視用DriveフォルダのIDを設定（Step1以降）
 **************************************************************************************************/

/* ================================ 設定 ================================ */
const CONFIG = {
  // 通知先（レポート送信先）
  REPORT_TO: 'noumi@cs-relations.co.jp',

  // Anthropic
  MODEL: 'claude-sonnet-4-5',       // ← 利用可能なモデルIDに合わせる
  MAX_TOKENS: 2000,
  ANTHROPIC_VERSION: '2023-06-01',

  // Drive監視（Step1以降）。未設定なら取得はスキップ＝安全に何もしない
  WATCH_FOLDER_ID: '',              // 未処理JSONを置くフォルダのID
  DONE_FOLDER_ID: '',               // 処理済みの退避先（任意。空なら移動しない）

  // 傾向ログ（作成済みスプレッドシートのID）※シートが無ければ自動生成
  LOG_SHEET_ID: '10-3E3XN3lWFScOsVxzbo-0uk0Iv-maeMP17aaroEyqA',
  LOG_SHEET_WIDE: '面談力ログ',
  LOG_SHEET_LONG: '面談力ログ_long',

  // 判定バンド（8軸×4点＝満点32点）
  GRADE: { GOOD: 27, OK: 20 },      // 合計>=27:良 / >=20:可 / それ未満:要改善

  // 二重送信防止台帳のプロパティ接頭辞
  LEDGER_PREFIX: 'sent__',
};

/* 8軸の定義（キー順＝ログ列順を固定） */
const AXES = [
  { key: 'listening',  label: '傾聴' },
  { key: 'questioning', label: '質問設計' },
  { key: 'initiative', label: '主導権' },
  { key: 'structure',  label: '構造化' },
  { key: 'appeal',     label: '訴求' },
  { key: 'objection',  label: '懸念対応' },
  { key: 'nextaction', label: 'next_action' },
  { key: 'impression', label: '印象' },
];

/* ログのヘッダー定義（appendLog_ と setupSpreadsheet で共用） */
const LOG_HEADERS_WIDE = [
  '日時', 'メンバー', '面談種別', '発話比率',
  '軸1_傾聴', '軸2_質問設計', '軸3_主導権', '軸4_構造化',
  '軸5_訴求', '軸6_懸念対応', '軸7_next_action', '軸8_印象',
  '合計', '判定', 'ソース',
];
const LOG_HEADERS_LONG = ['日時', 'メンバー', '面談種別', '軸名', 'スコア', 'ソース'];

/* 採点用システムプロンプト（コアIP。scoring_prompt.md と同一に保つ） */
const SYSTEM_PROMPT = [
  'あなたは採用面談の「面談力」を評価する、世界最高水準の面接トレーナーです。',
  '面接官（自社メンバー）の面談スキルを、以下の8軸で各0〜4点の整数で採点します。',
  '',
  '【8軸の定義】',
  '1. 傾聴(listening): 相手の発言を受け止め、要約・言い換え・感情の汲み取りができているか。',
  '2. 質問設計(questioning): 目的から逆算した質問設計。オープン/クローズドの使い分け、深掘りの質。',
  '3. 主導権(initiative): 面談の流れをコントロールできているか。※発話比率(interviewer_ratio)を根拠に判断。話し過ぎ/放任は減点。',
  '4. 構造化(structure): 導入→本論→クロージングの構成。時間配分と論点整理。',
  '5. 訴求(appeal): 自社/ポジションの魅力を、相手の動機に接続して伝えられているか。',
  '6. 懸念対応(objection): 相手の不安・懸念を引き出し、具体で解消できているか。',
  '7. next_action(nextaction): 次工程への合意形成と、相手が動きやすい明確な次アクション提示。',
  '8. 印象(impression): 信頼感・熱量・言葉遣い等の総合印象。',
  '',
  '【出力形式】必ず次のJSONのみを返す（前後に説明文やコードフェンスを付けない）:',
  '{',
  '  "scores": {"listening":0,"questioning":0,"initiative":0,"structure":0,"appeal":0,"objection":0,"nextaction":0,"impression":0},',
  '  "comments": {"listening":"","questioning":"","initiative":"","structure":"","appeal":"","objection":"","nextaction":"","impression":""},',
  '  "timeline": [{"phase":"導入","note":""},{"phase":"本論","note":""},{"phase":"クロージング","note":""}],',
  '  "order_diagnosis": "",',
  '  "moves_good": ["", ""],',
  '  "moves_improve": ["", ""],',
  '  "next_action": ""',
  '}',
  '',
  '【採点の原則】',
  '- scoresは0〜4の整数のみ。全軸を必ず埋める。',
  '- commentsは各軸1文。抽象論ではなく、文中の具体的な発言・場面を根拠にする。',
  '- timelineは面談の流れを3〜5フェーズで、各フェーズで何が起きたかを短く。',
  '- order_diagnosisは「質問や訴求の順序」が適切だったかの診断（例: 訴求が早すぎて動機把握が浅い等）。',
  '- moves_good/moves_improveは、再現/改善すべき「具体的なムーブ（言い回し・振る舞い）」を挙げる。',
  '- next_actionは、この面接官が次回すぐ試せる、最も効果の高い改善アクションを1つに絞る。',
  '- interviewer_ratio（面接官の発話比率）が提示された場合、主導権軸の根拠として明示的に用いる。',
].join('\n');

/* ============================ メイン処理 ============================ */

/**
 * バッチ実行のエントリポイント。トリガーに設定するのはこの関数。
 * （※ Step2の全自動化は fetchNewMeetingTranscripts_ が実データを返せる状態になってから）
 */
function runMeetingFbBatch() {
  const started = new Date();
  Logger.log('実行開始');

  const items = fetchNewMeetingTranscripts_();
  if (!items || items.length === 0) {
    Logger.log('新規なし');
    Logger.log('実行完了');
    return;
  }

  let ok = 0, skip = 0, err = 0;
  items.forEach(function (item) {
    try {
      if (isProcessed_(item.id)) { skip++; return; }
      processOne_(item);
      markProcessed_(item.id);
      moveToDone_(item);
      ok++;
    } catch (e) {
      err++;
      Logger.log('エラー(' + (item && item.id) + '): ' + e);
    }
  });

  Logger.log('処理結果 送信' + ok + ' / 既送' + skip + ' / 失敗' + err);
  Logger.log('所要 ' + ((new Date() - started) / 1000) + '秒');
  Logger.log('実行完了');
}

/**
 * 1件を採点→整形→送信→ログ追記まで通す。
 */
function processOne_(item) {
  const t = item.transcript;                 // 正規化済み: {segments:[{start,end,speaker,content}], member, type, date}
  const ratio = computeSpeechRatio_(t.segments, t.interviewerSpeaker);
  const ai = scoreTranscript_(t, ratio);     // Claude採点（JSON）
  const total = sumScores_(ai.scores);
  const band = computeBand_(total);          // 判定はコード側で確定（AIの気分でブレさせない）

  const report = buildReport_(t, ratio, ai, total, band);
  sendReport_(t, report);
  appendLog_(t, ratio, ai.scores, total, band, item.id);
}

/* ===================== 取得（経路①：Drive監視） ===================== */

/**
 * 監視フォルダの未処理JSONを読み込み、内部標準へ正規化して返す。
 * WATCH_FOLDER_ID 未設定なら空配列（＝安全に何もしない）。
 * @return {Array<{id:string, file:GoogleAppsScript.Drive.File, transcript:Object}>}
 */
function fetchNewMeetingTranscripts_() {
  if (!CONFIG.WATCH_FOLDER_ID) { Logger.log('WATCH_FOLDER_ID 未設定'); return []; }

  const folder = DriveApp.getFolderById(CONFIG.WATCH_FOLDER_ID);
  const out = [];
  const seen = {};

  function consider(file) {
    const name = file.getName();
    if (seen[file.getId()]) return;
    if (!/\.json$/i.test(name) && !/\.txt$/i.test(name)) return;
    seen[file.getId()] = true;
    let raw, json;
    try { raw = file.getBlob().getDataAsString('UTF-8'); json = JSON.parse(raw); }
    catch (e) { Logger.log('JSON解析失敗 skip: ' + name); return; }
    out.push({ id: file.getId(), file: file, transcript: normalizeTranscript_(json, name) });
  }

  const byType = folder.getFilesByType(MimeType.PLAIN_TEXT);
  while (byType.hasNext()) consider(byType.next());
  const all = folder.getFiles();
  while (all.hasNext()) consider(all.next());

  return out;
}

/**
 * 各社ブリッジの形式差を内部標準へ正規化する。
 * 対応: segments|transcript|utterances、start|startMs|start_time（ms/秒自動判定）、
 *       speaker|speaker_label|spk、content|text|words。
 */
function normalizeTranscript_(json, filename) {
  const rawSegs = json.segments || json.transcript || json.utterances || json.results || [];
  const segments = rawSegs.map(function (s) {
    return {
      start:   toSeconds_(pick_(s, ['start', 'startMs', 'start_time', 'begin', 'ts'])),
      end:     toSeconds_(pick_(s, ['end', 'endMs', 'end_time', 'stop'])),
      speaker: String(pick_(s, ['speaker', 'speaker_label', 'spk', 'role']) || '').trim() || 'unknown',
      content: String(pick_(s, ['content', 'text', 'transcript', 'words']) || '').trim(),
    };
  }).filter(function (s) { return s.content; });

  const interviewerSpeaker =
    json.interviewerSpeaker || json.interviewer_speaker ||
    guessInterviewer_(segments);

  // ファイル名からメタ情報を補完: 「YYYYMMDD_メンバー_種別.json」形式を想定
  const fromName = parseFilenameMeta_(filename);

  return {
    segments: segments,
    interviewerSpeaker: interviewerSpeaker,
    member: json.member || json.interviewer || json.owner || fromName.member || '（未設定）',
    type:   json.meetingType || json.type || fromName.type || '面談',
    date:   json.date || json.datetime || fromName.date || Utilities.formatDate(new Date(), 'JST', 'yyyy-MM-dd'),
    title:  json.title || filename,
  };
}

/**
 * ファイル名からメタ情報を抽出する。
 * 例: 「20260910_田川_一次面談.json」→ {date:'2026-09-10', member:'田川', type:'一次面談'}
 * 区切りは「_」。先頭がYYYYMMDD(8桁)なら日付として解釈。過不足は空で返す。
 */
function parseFilenameMeta_(filename) {
  const base = String(filename || '').replace(/\.[^.]+$/, ''); // 拡張子除去
  const parts = base.split('_');
  const out = { date: '', member: '', type: '' };
  let idx = 0;
  if (parts[0] && /^\d{8}$/.test(parts[0])) {
    out.date = parts[0].slice(0, 4) + '-' + parts[0].slice(4, 6) + '-' + parts[0].slice(6, 8);
    idx = 1;
  }
  if (parts[idx]) out.member = parts[idx];
  if (parts[idx + 1]) out.type = parts[idx + 1];
  return out;
}

function guessInterviewer_(segments) {
  if (!segments.length) return 'unknown';
  const labeled = segments.find(function (s) { return /interv|host|面接|自社/i.test(s.speaker); });
  return labeled ? labeled.speaker : segments[0].speaker;
}

/* ===================== 発話比率（機械計算） ===================== */

/**
 * 面接官の発話比率を秒数ベースで機械計算する（軸3の客観根拠）。
 * durationが無いsegmentは文字数比で補完。
 */
function computeSpeechRatio_(segments, interviewerSpeaker) {
  const acc = {};
  let usedDuration = false;
  segments.forEach(function (s) {
    const dur = (isFinite(s.end) && isFinite(s.start) && s.end > s.start) ? (s.end - s.start) : 0;
    const weight = dur > 0 ? (usedDuration = true, dur) : s.content.length;
    acc[s.speaker] = (acc[s.speaker] || 0) + weight;
  });
  const total = Object.keys(acc).reduce(function (a, k) { return a + acc[k]; }, 0) || 1;
  const bySpeaker = {};
  Object.keys(acc).forEach(function (k) { bySpeaker[k] = acc[k] / total; });
  return {
    interviewerRatio: bySpeaker[interviewerSpeaker] || 0,
    bySpeaker: bySpeaker,
    basis: usedDuration ? '秒数' : '文字数',
  };
}

/* ===================== 採点（Claude API） ===================== */

function scoreTranscript_(t, ratio) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY が未設定です（スクリプト プロパティに登録してください）');

  const dialogue = t.segments.map(function (s) {
    return '[' + fmtTime_(s.start) + '] ' + s.speaker + ': ' + s.content;
  }).join('\n');

  const userMsg =
    '面接官: ' + t.member + '\n' +
    '面談種別: ' + t.type + '\n' +
    '面接官の発話比率(interviewer_ratio): ' + Math.round(ratio.interviewerRatio * 100) + '%'
      + '（算出根拠: ' + ratio.basis + '）\n\n' +
    '=== 文字起こし ===\n' + dialogue;

  const payload = {
    model: CONFIG.MODEL,
    max_tokens: CONFIG.MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMsg }],
  };

  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': CONFIG.ANTHROPIC_VERSION },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  if (code !== 200) throw new Error('Anthropic API エラー ' + code + ': ' + res.getContentText());

  const body = JSON.parse(res.getContentText());
  const text = (body.content && body.content[0] && body.content[0].text) || '';
  return parseAiJson_(text);
}

function parseAiJson_(text) {
  let s = String(text).trim();
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) s = m[1].trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const obj = JSON.parse(s);
  AXES.forEach(function (ax) {
    if (!obj.scores) obj.scores = {};
    if (typeof obj.scores[ax.key] !== 'number') obj.scores[ax.key] = 0;
    obj.scores[ax.key] = Math.max(0, Math.min(4, Math.round(obj.scores[ax.key])));
    if (!obj.comments) obj.comments = {};
    if (!obj.comments[ax.key]) obj.comments[ax.key] = '';
  });
  obj.timeline = obj.timeline || [];
  obj.moves_good = obj.moves_good || [];
  obj.moves_improve = obj.moves_improve || [];
  obj.order_diagnosis = obj.order_diagnosis || '';
  obj.next_action = obj.next_action || '';
  return obj;
}

/* ===================== 集計・判定 ===================== */

function sumScores_(scores) {
  return AXES.reduce(function (a, ax) { return a + (scores[ax.key] || 0); }, 0);
}

function computeBand_(total) {
  if (total >= CONFIG.GRADE.GOOD) return { label: '良', color: '#137333' };
  if (total >= CONFIG.GRADE.OK)   return { label: '可', color: '#b06000' };
  return { label: '要改善', color: '#c5221f' };
}

/* ===================== レポート整形（HTMLメール） ===================== */

function buildReport_(t, ratio, ai, total, band) {
  const rows = AXES.map(function (ax) {
    return '<tr>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #eee;">' + ax.label + '</td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center;font-weight:bold;">' +
        (ai.scores[ax.key]) + ' / 4</td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #eee;color:#444;">' +
        esc_(ai.comments[ax.key]) + '</td>' +
    '</tr>';
  }).join('');

  const timeline = (ai.timeline || []).map(function (p) {
    return '<li><b>' + esc_(p.phase) + '</b>: ' + esc_(p.note) + '</li>';
  }).join('');

  const good = (ai.moves_good || []).map(function (x) { return '<li>' + esc_(x) + '</li>'; }).join('');
  const improve = (ai.moves_improve || []).map(function (x) { return '<li>' + esc_(x) + '</li>'; }).join('');
  const ratioPct = Math.round(ratio.interviewerRatio * 100);

  const html =
  '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:680px;color:#202124;">' +
    '<h2 style="margin:0 0 4px;">面談フィードバック</h2>' +
    '<div style="color:#5f6368;font-size:13px;margin-bottom:14px;">' +
      esc_(t.member) + '｜' + esc_(t.type) + '｜' + esc_(t.date) + '｜' + esc_(t.title) +
    '</div>' +

    '<div style="display:inline-block;padding:10px 16px;border-radius:8px;background:#f8f9fa;margin-bottom:16px;">' +
      '<span style="font-size:13px;color:#5f6368;">合計</span> ' +
      '<span style="font-size:24px;font-weight:bold;">' + total + '</span>' +
      '<span style="font-size:13px;color:#5f6368;"> / 32</span>' +
      '<span style="margin-left:12px;padding:3px 12px;border-radius:12px;color:#fff;font-weight:bold;background:' + band.color + ';">' +
        band.label + '</span>' +
      '<span style="margin-left:12px;font-size:13px;color:#5f6368;">面接官の発話比率 ' + ratioPct + '%（' + ratio.basis + '）</span>' +
    '</div>' +

    '<table style="border-collapse:collapse;width:100%;margin-bottom:18px;font-size:14px;">' +
      '<thead><tr style="background:#f1f3f4;">' +
        '<th style="padding:6px 10px;text-align:left;">軸</th>' +
        '<th style="padding:6px 10px;">スコア</th>' +
        '<th style="padding:6px 10px;text-align:left;">コメント</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +

    '<h3 style="margin:18px 0 6px;">A. 構成タイムライン</h3>' +
    '<ul style="margin:0 0 14px;padding-left:20px;line-height:1.7;">' + (timeline || '<li>—</li>') + '</ul>' +

    '<h3 style="margin:18px 0 6px;">B. 順序診断</h3>' +
    '<p style="margin:0 0 14px;line-height:1.7;">' + (esc_(ai.order_diagnosis) || '—') + '</p>' +

    '<h3 style="margin:18px 0 6px;">C. ムーブ精密</h3>' +
    '<div style="display:flex;gap:24px;flex-wrap:wrap;">' +
      '<div style="min-width:240px;"><b style="color:#137333;">再現したい</b>' +
        '<ul style="margin:6px 0 0;padding-left:20px;line-height:1.7;">' + (good || '<li>—</li>') + '</ul></div>' +
      '<div style="min-width:240px;"><b style="color:#c5221f;">改善したい</b>' +
        '<ul style="margin:6px 0 0;padding-left:20px;line-height:1.7;">' + (improve || '<li>—</li>') + '</ul></div>' +
    '</div>' +

    '<h3 style="margin:18px 0 6px;">D. 次回アクション（まず1つ）</h3>' +
    '<div style="padding:12px 16px;background:#e8f0fe;border-radius:8px;line-height:1.7;">' +
      (esc_(ai.next_action) || '—') + '</div>' +

    '<p style="margin-top:20px;color:#9aa0a6;font-size:12px;">自動生成レポート（8軸採点／判定はスコアから確定）</p>' +
  '</div>';

  const subject = '[面談FB] ' + t.member + '｜' + band.label + '（' + total + '/32）｜' + t.type + ' ' + t.date;
  return { subject: subject, html: html };
}

/* ===================== 送信 ===================== */

function sendReport_(t, report) {
  GmailApp.sendEmail(CONFIG.REPORT_TO, report.subject, '（HTML対応クライアントでご覧ください）', {
    htmlBody: report.html,
    name: '面談FB Bot',
  });
}

/* ===================== 傾向ログ（2形式・自己修復） ===================== */

/**
 * 指定名のシートを取得。無ければ作成し、ヘッダーを投入して返す。
 */
function ensureLogSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
  }
  // ヘッダーが未投入（1行目が空）なら投入
  if (sh.getLastRow() === 0 || !sh.getRange(1, 1).getValue()) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    sh.getRange('1:1').setFontWeight('bold');
  }
  return sh;
}

function appendLog_(t, ratio, scores, total, band, sourceId) {
  if (!CONFIG.LOG_SHEET_ID) return;  // 未設定ならログはスキップ
  const ss = SpreadsheetApp.openById(CONFIG.LOG_SHEET_ID);
  const now = new Date();
  const ratioPct = Math.round(ratio.interviewerRatio * 100) + '%';

  // ワイド形式：1面談＝1行（無ければ自動生成）
  const wide = ensureLogSheet_(ss, CONFIG.LOG_SHEET_WIDE, LOG_HEADERS_WIDE);
  wide.appendRow([
    now, t.member, t.type, ratioPct,
    scores.listening, scores.questioning, scores.initiative, scores.structure,
    scores.appeal, scores.objection, scores.nextaction, scores.impression,
    total, band.label, t.title,
  ]);

  // ロング形式：1面談×1軸＝1行（無ければ自動生成／Looker Studioのヒートマップ用）
  const long = ensureLogSheet_(ss, CONFIG.LOG_SHEET_LONG, LOG_HEADERS_LONG);
  AXES.forEach(function (ax) {
    long.appendRow([now, t.member, t.type, ax.label, scores[ax.key], t.title]);
  });
}

/* ===================== 二重送信防止 ＆ ファイル退避 ===================== */

function isProcessed_(id) {
  return !!PropertiesService.getScriptProperties().getProperty(CONFIG.LEDGER_PREFIX + id);
}
function markProcessed_(id) {
  PropertiesService.getScriptProperties().setProperty(CONFIG.LEDGER_PREFIX + id, new Date().toISOString());
}
function moveToDone_(item) {
  if (!CONFIG.DONE_FOLDER_ID || !item.file) return;
  try {
    const done = DriveApp.getFolderById(CONFIG.DONE_FOLDER_ID);
    done.addFile(item.file);
    DriveApp.getFolderById(CONFIG.WATCH_FOLDER_ID).removeFile(item.file);
  } catch (e) { Logger.log('退避失敗: ' + e); }
}

/* ===================== ユーティリティ ===================== */

function pick_(obj, keys) {
  for (var i = 0; i < keys.length; i++) if (obj[keys[i]] !== undefined && obj[keys[i]] !== null) return obj[keys[i]];
  return undefined;
}
// ms/秒を自動判定して秒に統一（100000超はms扱い）
function toSeconds_(v) {
  const n = Number(v);
  if (!isFinite(n)) return NaN;
  return n > 100000 ? n / 1000 : n;
}
function fmtTime_(sec) {
  if (!isFinite(sec)) return '--:--';
  const s = Math.floor(sec % 60), m = Math.floor(sec / 60);
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}
function esc_(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ===================== セットアップ・テスト ===================== */

/**
 * ★通常は不要★（LOG_SHEET_ID 設定済み・シートは自動生成されるため）
 * 新しくログ用スプレッドシートを作りたい場合のみ実行する。
 * すでに LOG_SHEET_ID が設定済みなら、誤操作による増殖を防ぐため停止する。
 */
function setupSpreadsheet() {
  if (CONFIG.LOG_SHEET_ID) {
    Logger.log('中止: CONFIG.LOG_SHEET_ID が設定済みです（' + CONFIG.LOG_SHEET_ID + '）。');
    Logger.log('新規作成したい場合は、CONFIG.LOG_SHEET_ID を空にしてから再実行してください。');
    return;
  }
  const ss = SpreadsheetApp.create('面談力ログ_' + Utilities.formatDate(new Date(), 'JST', 'yyyyMMdd'));
  ensureLogSheet_(ss, CONFIG.LOG_SHEET_WIDE, LOG_HEADERS_WIDE);
  ensureLogSheet_(ss, CONFIG.LOG_SHEET_LONG, LOG_HEADERS_LONG);
  // 既定の空シート（シート1）が残っていれば削除
  const def = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);

  Logger.log('作成完了 URL → ' + ss.getUrl());
  Logger.log('CONFIG.LOG_SHEET_ID に設定 → ' + ss.getId());
  return ss.getUrl();
}

/**
 * Step0: APIキー不要のサンプル送信。体裁確認用（ログにも追記される）。
 */
function sendTestReport() {
  const t = {
    segments: [
      { start: 0,  end: 20, speaker: 'interviewer', content: '本日はお時間ありがとうございます。まず最近のお仕事の状況から伺えますか。' },
      { start: 20, end: 70, speaker: 'candidate',   content: '今は法人営業で、新規開拓を担当しています。裁量は大きいのですが評価制度に課題を感じていて…' },
      { start: 70, end: 85, speaker: 'interviewer', content: 'なるほど、評価制度の何が一番引っかかっていますか。' },
      { start: 85, end: 130, speaker: 'candidate',  content: 'プロセスが数字だけで見られる点です。関係構築の努力が反映されにくくて。' },
      { start: 130, end: 160, speaker: 'interviewer', content: '当社はまさにそこを重視していて、関係構築の質を評価に組み込んでいます。' },
    ],
    interviewerSpeaker: 'interviewer',
    member: '（サンプル）採用担当', type: '一次面談', date: Utilities.formatDate(new Date(), 'JST', 'yyyy-MM-dd'),
    title: 'サンプル面談',
  };
  const ratio = computeSpeechRatio_(t.segments, t.interviewerSpeaker);
  const ai = {
    scores: { listening:3, questioning:3, initiative:2, structure:3, appeal:3, objection:2, nextaction:2, impression:3 },
    comments: {
      listening:'「評価制度の何が引っかかるか」で相手の言葉を受けて深掘りできている。',
      questioning:'状況→課題の順で開いた質問。動機の核に触れる一歩手前。',
      initiative:'発話比率は適正圏だが、後半やや面接官主導に傾いた。',
      structure:'導入→本論の流れは明確。クロージングが未実施。',
      appeal:'評価制度の懸念に自社の強みを接続できた好例。',
      objection:'懸念を引き出せたが、具体事例での解消までは至らず。',
      nextaction:'次工程の合意形成が弱い。',
      impression:'落ち着いた傾聴姿勢で信頼感がある。',
    },
    timeline: [
      { phase:'導入', note:'お礼と現況ヒアリングで自然に開始。' },
      { phase:'本論', note:'課題（評価制度）を特定し、自社の強みへ接続。' },
      { phase:'クロージング', note:'未実施。次アクション提示が抜けた。' },
    ],
    order_diagnosis: '状況→課題の順序は良好。ただし訴求を早めに投下したため、動機の深掘りが浅いまま魅力提示に進んだ。',
    moves_good: ['相手の言葉を使った深掘り質問', '懸念に自社の強みを直結させた訴求'],
    moves_improve: ['懸念を具体事例で解消する', 'クロージングで次アクションを明確化する'],
    next_action: '面談の最後に「次回○日までに現場社員との面談を設定します」と、相手が動きやすい次の一歩を必ず1つ提示する。',
  };
  const total = sumScores_(ai.scores);
  const band = computeBand_(total);
  const report = buildReport_(t, ratio, ai, total, band);
  sendReport_(t, report);
  appendLog_(t, ratio, ai.scores, total, band, 'TEST_' + Date.now());
  Logger.log('サンプル送信完了 → ' + CONFIG.REPORT_TO + '（合計' + total + '/32・' + band.label + '）');
}
