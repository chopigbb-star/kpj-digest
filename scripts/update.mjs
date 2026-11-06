// 대한약사저널(약사공론 학술지) 주간 PDF → 기사 목록·요약 → data/articles.json
// 사용: node scripts/update.mjs [--max-issues N] [--only HOSU]
// 환경변수:
//   GEMINI_BACKEND=cli  → Antigravity CLI(agy, 구글 계정 로그인)   / 기본 api → GEMINI_API_KEY 사용
//   SUMMARY_MODEL       → 모델 이름 (cli 예: gemini-3.8-flash-medium, api 예: gemini-flash-latest)
//
// 수집 방식: 약사공론 PDF 서비스의 월별 학술지 목록(ylist.html)에서 호수를 찾고,
// 사이트의 '해당 호 전체보기'(check.php)로 PDF를 받아 Gemini에 통째로 넘긴다.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTICLES_FILE = path.join(ROOT, 'data/articles.json');
const STATE_FILE = path.join(ROOT, 'data/issues.json');

const BASE = 'https://www.kpanews.co.kr';
const START_MONTH = '2025-03';
const USER_AGENT = 'Mozilla/5.0 (compatible; KPJ-Digest/1.0; +https://chopigbb-star.github.io/kpj-digest/)';
const FETCH_DELAY_MS = 1500;

const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const MAX_ISSUES = Number(argVal('--max-issues', 20));
const ONLY = argVal('--only', '');
const BACKEND = process.env.GEMINI_BACKEND || 'api';
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || (BACKEND === 'cli' ? 'gemini-3.8-flash-medium' : 'gemini-flash-latest');
// 지시문을 바꾸면 올린다 → 이미 처리한 호도 다시 요약
const PROMPT_VERSION = 3; // 2: 이번 호 주제(issueTheme) 3: 핵심 3줄(keyPoints)·형광펜(==구절==)

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function get(url, asBuffer = false) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return asBuffer ? Buffer.from(await res.arrayBuffer()) : res.text();
}

function monthsSince(start) {
  const out = [];
  const d = new Date(`${start}-01T00:00:00Z`);
  const now = new Date(Date.now() + 9 * 3600e3); // KST
  while (d <= now) {
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

// 월별 목록에서 호수 찾기 (월은 반드시 두 자리: 03). 반환: [{hosu, date:'2026-11-02'}]
async function listIssues(month) {
  const [y, m] = month.split('-');
  const html = await get(`${BASE}/pdf/ylist.html?category=hagsul&syear=${y}&smonth=${m}`);
  return [...new Set([...html.matchAll(/hosu=(\d+)-(\d{4}-\d{2}-\d{2})/g)].map(x => `${x[1]}|${x[2]}`))]
    .map(s => { const [hosu, date] = s.split('|'); return { hosu: Number(hosu), date }; })
    .filter(i => i.date.startsWith(month)); // 이전·다음 달 링크 제외
}

function pdfUrl(issue, page = 1) {
  const [y, m, d] = issue.date.split('-');
  return `${BASE}/pdf/php/check.php?category=hagsul&y=${y}&m=${m}&d=${d}&page=1&hosu=${issue.hosu}#page=${page}`;
}

// 학술지 호(예: 323호) — 목록 페이지 머리말에서 읽는다
async function issueNumber(issue) {
  const y = issue.date.slice(0, 4);
  const html = await get(`${BASE}/pdf/list.html?category=hagsul&syear=${y}&hosu=${issue.hosu}-${issue.date}`);
  const m = html.match(/학술지\s*\d+년\s*\d+월\s*\d+일\s*(\d+)호/);
  return m ? Number(m[1]) : null;
}

const PROMPT = `너는 바쁜 약국 약사가 핵심을 빠르게 파악할 수 있게 학술지를 정리하는 편집자다.
첨부한 PDF는 약사공론 '대한약사저널'(학술지) 한 호 전체다. 이 호에 실린 학술·임상 기사를 모두 찾아 기사마다 정리하라.

이번 호 주제(issueTheme):
- 표지(1면) 등 맨 앞쪽에 크게 인쇄된 이번 호의 주제·특집 제목을 그대로 적는다. 예: "정신신경계2 파킨슨1", "구강질환 (구내염·구순포진·구각염 I)". 없으면 빈 문자열.

기사 고르기:
- 광고(전면·하단 광고, 제품 광고), 표지·목차·사고(社告)·행사 포스터·학술대회 안내처럼 학술 내용이 없는 면은 제외한다.
- 여러 면에 걸친 기사는 하나로 합친다. 광고 때문에 면이 건너뛰면 "12-13, 15"처럼 적는다.

기사 정보:
- category: 지면 상단에 인쇄된 코너명을 짧게 쓴다. 번호·회차는 뺀다. 예: "전문의약품(ETC)", "일반의약품(OTC)", "약대약", "한약제제", "건강기능식품", "비밀노트", "약국 AI".
- title은 큰 제목만, subtitle은 작은 부제. author는 "이름 + 약사/교수 등", affiliation은 괄호 속 소속.
- firstPage: 기사가 시작하는 면 번호(숫자).

keyPoints (핵심 3줄):
- 이 기사에서 가장 중요한 내용 정확히 3줄. 각 줄은 한 문장, 70자 안팎. 약사가 이 3줄만 읽어도 기사의 결론을 알 수 있게 쓴다.
- 구체적으로 쓴다(약물명·수치·권고 포함). "~를 다룬다", "~를 알아본다" 같은 소개 문장은 쓰지 않는다.

summaryPoints 작성 규칙:
- 4~6개 항목. 각 항목은 한 가지 주제만 다루고 1~3문장으로 쓴다. 기전·근거(임상연구 결과 등)·용법·주의사항처럼 약국에서 쓸모 있는 구체적 내용은 충분히 담는다. 기사가 짧으면 항목 수를 줄인다.
- 항목 맨 앞에 핵심어를 두고 콜론으로 시작한다. 예: "오라페인큐겔(리도카인+CPC): 국소마취로 통증을 빠르게 줄이고 항균 작용을 더한다."
- 여러 약을 비교하는 기사는 약(또는 제형)별로 항목을 나눈다. 한 문장에 약 이름을 3개 이상 나열하지 않는다.
- 마지막 1~2개 항목은 약국에서 바로 쓸 상담·복약지도 포인트나 주의사항(금기, 상호작용, 특정 환자군)으로 한다.
- 표·그림 속 내용도 읽어서 반영한다. 용량·수치·약물명은 PDF에 있는 그대로 쓰고, PDF에 없는 내용은 추가하지 않는다.
- 문체는 "~한다/~이다" 평서형으로 통일한다.
- 형광펜: 약국에서 꼭 기억해야 할 결정적인 구절(약물+용량·용법, 금기·주의 대상, 핵심 수치, 1차 선택약 같은 결론)을 ==이렇게== 감싼다. 항목마다 0~2곳, 한 곳은 25자 이내의 짧은 구절로, 문장 전체를 감싸지 않는다.

tags: 약물(성분)명·질환명 위주 3~4개, 공백 없이, # 없이.`;

const ARTICLE_FIELDS = ['pages', 'firstPage', 'category', 'title', 'subtitle', 'author', 'affiliation', 'keyPoints', 'summaryPoints', 'tags'];
const SCHEMA = {
  type: 'object',
  properties: {
    issueTheme: { type: 'string' },
    articles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pages: { type: 'string' },
          firstPage: { type: 'integer' },
          category: { type: 'string' },
          title: { type: 'string' },
          subtitle: { type: 'string' },
          author: { type: 'string' },
          affiliation: { type: 'string' },
          keyPoints: { type: 'array', items: { type: 'string' } },
          summaryPoints: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } }
        },
        required: ARTICLE_FIELDS
      }
    }
  },
  required: ['issueTheme', 'articles']
};

function parseJsonLoose(text) {
  const t = String(text || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(t); } catch {}
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) return JSON.parse(t.slice(i, j + 1));
  throw new Error(`JSON 파싱 실패: ${t.slice(0, 200)}`);
}

// Antigravity CLI: 읽기 전용(plan) 모드, 이 PDF 폴더만 읽기 허용 (명령 실행·쓰기 차단)
async function askAgy(pdfPath) {
  const dir = await fs.realpath(path.dirname(pdfPath)); // 맥 임시 폴더는 /var → /private/var 링크
  const file = path.join(dir, path.basename(pdfPath));
  const prompt = `${PROMPT}\n\n[PDF] 터미널 명령은 쓰지 말고 파일 보기 도구로 이 파일을 직접 열어 모든 면을 읽어라: ${file}\n\n파일을 만들거나 계획서를 쓰지 말고, 결과만 JSON 스키마에 맞춰 바로 답하라.`;
  const cliArgs = ['-p', prompt, '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA),
    '--mode', 'plan', '--print-timeout', '900s', '--add-dir', dir, '--model', SUMMARY_MODEL,
    '--settings', JSON.stringify({ permissions: { allow: [`read_file(${dir}/**)`] } })];
  const stdout = await new Promise((resolve, reject) => {
    execFile('agy', cliArgs, { cwd: dir, maxBuffer: 50 * 1024 * 1024, timeout: 16 * 60 * 1000 }, (err, out, errOut) => {
      if (err) {
        const msg = `${errOut || ''}${out || ''}`.replace(/\s+/g, ' ').slice(0, 400);
        reject(Object.assign(new Error(`Antigravity CLI 실패: ${msg}`), { quota: /quota|429|exhausted|rate limit/i.test(msg) }));
      } else resolve(out);
    });
  });
  if (process.env.KPJ_DEBUG) await fs.writeFile(path.join(process.env.KPJ_DEBUG, `agy-${Date.now()}.json`), stdout);
  const wrapped = JSON.parse(stdout);
  if (wrapped.status !== 'SUCCESS') throw new Error(`Antigravity CLI 상태 ${wrapped.status}: ${String(wrapped.response).slice(0, 200)}`);
  if (wrapped.denied_actions?.length) throw new Error(`권한 거부: ${JSON.stringify(wrapped.denied_actions)}`);
  let out = wrapped.structured_output;
  if (!out?.articles?.length) out = parseJsonLoose(wrapped.response);
  return out;
}

// Gemini API(예비용, GitHub Actions): PDF를 그대로 첨부
async function askApi(pdfPath) {
  const toApiSchema = s => {
    if (s.type === 'object') return { type: 'OBJECT', properties: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toApiSchema(v)])), required: s.required };
    if (s.type === 'array') return { type: 'ARRAY', items: toApiSchema(s.items) };
    return { type: s.type.toUpperCase() };
  };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${SUMMARY_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [
        { text: PROMPT },
        { inline_data: { mime_type: 'application/pdf', data: (await fs.readFile(pdfPath)).toString('base64') } }
      ] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: toApiSchema(SCHEMA) }
    })
  });
  if (!res.ok) {
    const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 300);
    throw Object.assign(new Error(`Gemini HTTP ${res.status}: ${text}`), { quota: res.status === 429 });
  }
  const data = await res.json();
  return parseJsonLoose(data.candidates?.[0]?.content?.parts?.map(p => p.text).join(''));
}

const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();

function toArticles(issue, issueNo, out) {
  const issueTheme = clean(out.issueTheme);
  return (out.articles || [])
    .filter(a => clean(a.title) && Array.isArray(a.summaryPoints) && a.summaryPoints.length)
    .map(a => {
      const first = Number(a.firstPage) || Number(String(a.pages).match(/\d+/)?.[0]) || 1;
      return {
        id: `kpj-${issue.hosu}-p${first}`,
        hosu: issue.hosu,
        issueNo,
        issueTheme,
        date: issue.date.replace(/-/g, '.'),
        pages: clean(a.pages),
        firstPage: first,
        category: clean(a.category) || '기타',
        title: clean(a.title),
        subtitle: clean(a.subtitle),
        author: clean(a.author),
        affiliation: clean(a.affiliation).replace(/^\(|\)$/g, ''),
        url: pdfUrl(issue, first),
        keyPoints: (a.keyPoints || []).map(s => clean(s).replace(/==/g, '')).filter(Boolean).slice(0, 3),
        summaryPoints: a.summaryPoints.map(clean).filter(Boolean).slice(0, 7),
        tags: (a.tags || []).map(t => clean(t).replace(/^#/, '')).filter(Boolean).slice(0, 5),
        summarizedBy: SUMMARY_MODEL
      };
    })
    // 같은 면에서 시작하는 기사가 둘이면 id가 겹치지 않게
    .map((a, i, arr) => (arr.findIndex(b => b.id === a.id) === i ? a : { ...a, id: `${a.id}-${i}` }));
}

async function main() {
  if (BACKEND !== 'cli' && !process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY 없음');
  let articles = await readJson(ARTICLES_FILE, []);
  const state = await readJson(STATE_FILE, { months: {}, issues: {} });

  // 1) 호수 찾기: 지난달·이번달은 매번, 그 전 달은 한 번 찾았으면 다시 안 봄
  const months = monthsSince(START_MONTH);
  const recent = months.slice(-2);
  for (const month of months) {
    if (state.months[month]?.length && !recent.includes(month)) continue;
    try {
      const found = await listIssues(month);
      state.months[month] = found.map(f => f.hosu);
      for (const f of found) state.issues[f.hosu] = { ...(state.issues[f.hosu] || {}), date: f.date };
    } catch (e) {
      console.warn(`목록 실패 ${month}: ${e.message}`);
    }
    await sleep(FETCH_DELAY_MS);
  }

  // 2) 아직 처리 안 한 호 (최신 호부터)
  const todo = Object.entries(state.issues)
    .map(([hosu, v]) => ({ hosu: Number(hosu), ...v }))
    .filter(i => (ONLY ? i.hosu === Number(ONLY) : (i.promptVersion || 0) < PROMPT_VERSION))
    .sort((a, b) => (a.promptVersion ? 1 : 0) - (b.promptVersion ? 1 : 0) || b.hosu - a.hosu);
  console.log(`호수 ${Object.keys(state.issues).length}개 중 처리할 호 ${todo.length}개 (이번 실행 최대 ${MAX_ISSUES})`);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kpj-pdf-'));
  let done = 0;
  try {
    for (const issue of todo.slice(0, MAX_ISSUES)) {
      const t0 = Date.now();
      try {
        const issueNo = issue.issueNo || await issueNumber(issue);
        const pdfPath = path.join(tmp, `${issue.hosu}.pdf`);
        const pdf = await get(pdfUrl(issue).replace(/#.*$/, ''), true);
        if (pdf.subarray(0, 4).toString() !== '%PDF') throw new Error('PDF가 아님');
        await fs.writeFile(pdfPath, pdf);
        const out = BACKEND === 'cli' ? await askAgy(pdfPath) : await askApi(pdfPath);
        await fs.rm(pdfPath, { force: true });
        const found = toArticles(issue, issueNo, out);
        if (!found.length) throw new Error('기사를 찾지 못함');
        articles = articles.filter(a => a.hosu !== issue.hosu).concat(found);
        state.issues[issue.hosu] = { ...state.issues[issue.hosu], issueNo, issueTheme: found[0].issueTheme, promptVersion: PROMPT_VERSION, articles: found.length };
        done++;
        console.log(`제${issueNo}호(${issue.date}) [${found[0].issueTheme}] 기사 ${found.length}편 — ${Math.round((Date.now() - t0) / 1000)}초`);
        found.forEach(a => console.log(`   ${a.pages}면 [${a.category}] ${a.title}`));
        // 한 호 끝날 때마다 저장 (중간에 멈춰도 진행분 유지)
        articles.sort((a, b) => b.date.localeCompare(a.date) || a.firstPage - b.firstPage);
        await fs.writeFile(ARTICLES_FILE, JSON.stringify(articles, null, 2) + '\n');
        await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 1) + '\n');
      } catch (e) {
        console.warn(`실패 hosu ${issue.hosu} (${issue.date}): ${e.message}`);
        if (e.quota) break;
      }
      await sleep(FETCH_DELAY_MS);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 1) + '\n');
  console.log(`처리: ${done}개 호, 남은 호 ${todo.length - done}개, 전체 기사 ${articles.length}편`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
