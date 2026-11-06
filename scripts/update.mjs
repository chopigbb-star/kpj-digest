// 대한약사저널 기사 수집 + Gemini 요약 → data/articles.json
// 사용: node scripts/update.mjs [--no-summarize] [--max-fetch N] [--max-summaries N]
// 환경변수: GEMINI_API_KEY (요약 시 필요), GEMINI_MODEL (기본 gemini-flash-latest)
//
// 수집 방식: 약사공론 공식 RSS(최신 기사) + 대한약사저널 기사 본문 하단의 '같은 코너 이전 글' 링크를
// 따라가며 START_DATE 이후 기사를 찾는다. 목록 페이지는 쓰지 않는다.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTICLES_FILE = path.join(ROOT, 'data/articles.json');
const STATE_FILE = path.join(ROOT, 'data/crawl-state.json');

const BASE = 'https://www.kpanews.co.kr';
const RSS_URL = `${BASE}/rss/allArticle.xml`;
const START_DATE = '2025-03-01';
const SECTION = '대한약사저널';
// 크롤링 시작점으로 쓰는 확인된 대한약사저널 기사 (코너별 최근 글)
const SEED_IDS = [547636, 547650, 547657, 547629];
const FETCH_DELAY_MS = 800;
const USER_AGENT = 'Mozilla/5.0 (compatible; KPJ-Digest/1.0; +https://chopigbb-star.github.io/kpj-digest/)';

const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const NO_SUMMARIZE = args.includes('--no-summarize');
const MAX_FETCH = argVal('--max-fetch', 400);
const MAX_SUMMARIES = argVal('--max-summaries', 30);
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const GEMINI_DELAY_MS = 7000; // 무료 등급 분당 호출 제한 대비

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

const decode = s => s
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

const meta = (html, prop) => {
  const m = html.match(new RegExp(`(?:property|name)="${prop}"\\s+content="([^"]*)"`));
  return m ? decode(decode(m[1])).trim() : '';
};

function parseArticle(idxno, html) {
  const section = meta(html, 'article:section');
  const published = meta(html, 'article:published_time'); // 2026-11-02T05:51:00+09:00
  const titleTag = decode(decode((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || ''));
  // "[약대약] 아시클로버 vs 발라시클로버 < 약대약 < 대한약사저널 < 기사본문 - 약사공론"
  const parts = titleTag.split(' < ').map(s => s.trim());
  const title = parts[0] || meta(html, 'og:title').replace(/\s*-\s*약사공론$/, '');
  const category = parts.length >= 3 && parts[2] === SECTION ? parts[1] : SECTION;
  const links = [...new Set([...html.matchAll(/articleView\.html\?idxno=(\d+)/g)].map(m => Number(m[1])))]
    .filter(id => id !== idxno);

  let body = '';
  const start = html.indexOf('itemprop="articleBody"');
  if (start >= 0) {
    const end = html.indexOf('</article>', start);
    body = decode(html.slice(start, end > 0 ? end : start + 60000)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/^itemprop="articleBody">/, ''))
      .replace(/\s+/g, ' ').trim();
  }

  return {
    isJournal: section === SECTION,
    published,
    links,
    body,
    article: {
      id: `kpj-${idxno}`,
      idxno,
      title,
      category,
      author: meta(html, 'og:article:author'),
      date: published.slice(0, 10).replace(/-/g, '.'),
      url: `${BASE}/news/articleView.html?idxno=${idxno}`,
      summaryPoints: [],
      tags: []
    }
  };
}

async function discover(articles, state) {
  const known = new Set(articles.map(a => a.idxno));
  const checked = new Set(state.checkedNonJournal || []);
  const queue = [];
  const enqueue = id => {
    if (!known.has(id) && !checked.has(id) && !queue.includes(id)) queue.push(id);
  };

  SEED_IDS.forEach(enqueue);
  (await researchPastMonths(state)).forEach(enqueue);
  try {
    const rss = await get(RSS_URL);
    [...rss.matchAll(/idxno=(\d+)/g)].forEach(m => enqueue(Number(m[1])));
  } catch (e) {
    console.warn('RSS 실패:', e.message);
  }
  // 이전 실행에서 한도 때문에 못 본 후보
  (state.pending || []).forEach(enqueue);

  let fetched = 0, added = 0;
  while (queue.length && fetched < MAX_FETCH) {
    // 큰 번호(최신)부터 처리
    queue.sort((a, b) => b - a);
    const id = queue.shift();
    let html;
    try {
      html = await get(`${BASE}/news/articleView.html?idxno=${id}`);
    } catch (e) {
      console.warn(e.message);
      checked.add(id);
      continue;
    } finally {
      fetched++;
      await sleep(FETCH_DELAY_MS);
    }
    const p = parseArticle(id, html);
    if (!p.isJournal || !p.published || p.published.slice(0, 10) < START_DATE) {
      checked.add(id);
      continue;
    }
    articles.push(p.article);
    known.add(id);
    added++;
    console.log(`+ ${p.article.date} [${p.article.category}] ${p.article.title}`);
    // 대한약사저널 기사의 링크(같은 코너 이전·다음 글 포함)를 다음 후보로
    p.links.forEach(enqueue);
  }

  state.pending = queue;
  state.checkedNonJournal = [...checked].sort((a, b) => b - a).slice(0, 30000);
  console.log(`수집: 페이지 ${fetched}건 확인, 새 기사 ${added}건, 남은 후보 ${queue.length}건`);
}

// 과거 기사 찾기: Gemini + Google 검색으로 월별 기사 URL 후보를 받는다.
// 후보는 discover()에서 실제 기사 페이지를 열어 대한약사저널·날짜를 확인한 뒤에만 추가된다.
const MAX_RESEARCH_MONTHS = argVal('--max-research', 4);
const RESEARCH_ATTEMPTS = 2;

function monthsSinceStart() {
  const out = [];
  const d = new Date(`${START_DATE}T00:00:00Z`);
  const now = new Date();
  while (d <= now) {
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

async function geminiRequest(body) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify(body)
    }
  );
  if (res.status === 429) throw Object.assign(new Error('Gemini 사용량 한도 도달'), { quota: true });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function resolveRedirect(uri) {
  try {
    const res = await fetch(uri, { redirect: 'manual' });
    return res.headers.get('location') || '';
  } catch { return ''; }
}

async function researchPastMonths(state) {
  if (NO_SUMMARIZE || !process.env.GEMINI_API_KEY) return [];
  state.research = state.research || {};
  const thisMonth = new Date().toISOString().slice(0, 7);
  // 이번 달은 RSS로 채워지므로 지난달까지만, 오래된 달부터
  const todo = monthsSinceStart()
    .filter(m => m < thisMonth && (state.research[m] || 0) < RESEARCH_ATTEMPTS)
    .slice(0, MAX_RESEARCH_MONTHS);
  const ids = new Set();
  for (const month of todo) {
    const [y, m] = month.split('-').map(Number);
    const prompt = `약사공론(kpanews.co.kr) '대한약사저널' 섹션에 ${y}년 ${m}월에 게재된 기사를 Google 검색으로 최대한 많이 찾아라.
코너 예: [약대약], [전문의약품(ETC)], [일반의약품], [박정빈 약사의 비밀노트], [무엇이든 물어보세요] 등.
각 기사마다 한 줄씩 "제목 | https://www.kpanews.co.kr/news/articleView.html?idxno=번호" 형식으로만 답하라. 확인되지 않은 번호는 쓰지 마라.`;
    try {
      const data = await geminiRequest({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }]
      });
      const cand = data.candidates?.[0] || {};
      const text = cand.content?.parts?.map(p => p.text || '').join('') || '';
      const found = new Set([...text.matchAll(/idxno=(\d+)/g)].map(x => Number(x[1])));
      for (const chunk of cand.groundingMetadata?.groundingChunks || []) {
        const uri = chunk.web?.uri || '';
        const direct = uri.match(/kpanews\.co\.kr.*idxno=(\d+)/);
        const loc = direct ? uri : await resolveRedirect(uri);
        const mm = loc.match(/kpanews\.co\.kr.*idxno=(\d+)/);
        if (mm) found.add(Number(mm[1]));
      }
      found.forEach(id => ids.add(id));
      state.research[month] = (state.research[month] || 0) + 1;
      console.log(`리서치 ${month}: 후보 ${found.size}건`);
    } catch (e) {
      console.warn(`리서치 실패 ${month}: ${e.message}`);
      if (e.quota) break;
    }
    await sleep(GEMINI_DELAY_MS);
  }
  return [...ids];
}

const SUMMARY_PROMPT =`너는 약국 약사를 위한 학술 기사 요약가다. 아래 약사공론 '대한약사저널' 기사 본문만 근거로 요약하라.
- summaryPoints: 3~4개의 한국어 문장. 핵심 기전·특징, 약국 복약지도/상담 포인트, 부작용·상호작용·주의사항 순으로.
- 수치·약물명은 본문에 있는 그대로 쓰고, 본문에 없는 내용은 추가하지 마라.
- tags: 약물명·질환명 위주 3~4개 (공백 없이, # 없이).`;

async function summarize(article, body) {
  const data = await geminiRequest({
    contents: [{ parts: [{ text: `${SUMMARY_PROMPT}\n\n제목: ${article.title}\n\n본문:\n${body.slice(0, 15000)}` }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          summaryPoints: { type: 'ARRAY', items: { type: 'STRING' } },
          tags: { type: 'ARRAY', items: { type: 'STRING' } }
        },
        required: ['summaryPoints', 'tags']
      }
    }
  });
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  const out = JSON.parse(text);
  if (!Array.isArray(out.summaryPoints) || out.summaryPoints.length === 0) throw new Error('빈 요약');
  return out;
}

async function summarizePending(articles) {
  if (NO_SUMMARIZE) return;
  if (!process.env.GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY 없음 — 요약 건너뜀');
    return;
  }
  // 최신 기사부터 요약
  const pending = articles.filter(a => !a.summaryPoints?.length).sort((a, b) => b.idxno - a.idxno);
  let done = 0;
  for (const a of pending.slice(0, MAX_SUMMARIES)) {
    try {
      const html = await get(a.url);
      const { body } = parseArticle(a.idxno, html);
      if (body.length < 200) { console.warn(`본문 짧음, 건너뜀: ${a.title}`); continue; }
      const out = await summarize(a, body);
      a.summaryPoints = out.summaryPoints.map(s => s.trim()).filter(Boolean).slice(0, 5);
      a.tags = out.tags.map(t => t.replace(/^#/, '').trim()).filter(Boolean).slice(0, 5);
      a.summarizedBy = GEMINI_MODEL;
      done++;
      console.log(`요약 완료: ${a.title}`);
    } catch (e) {
      console.warn(`요약 실패 (${a.title}): ${e.message}`);
      if (e.quota) break;
    }
    await sleep(GEMINI_DELAY_MS);
  }
  console.log(`요약: ${done}건 완료, 남은 요약 대기 ${pending.length - done}건`);
}

async function main() {
  const articles = await readJson(ARTICLES_FILE, []);
  const state = await readJson(STATE_FILE, {});

  await discover(articles, state);
  // 중간 결과부터 저장 (요약 단계에서 실패해도 수집분은 남김)
  articles.sort((a, b) => b.date.localeCompare(a.date) || b.idxno - a.idxno);
  await fs.writeFile(ARTICLES_FILE, JSON.stringify(articles, null, 2) + '\n');
  await fs.writeFile(STATE_FILE, JSON.stringify(state) + '\n');

  await summarizePending(articles);
  await fs.writeFile(ARTICLES_FILE, JSON.stringify(articles, null, 2) + '\n');
}

main().catch(e => { console.error(e); process.exit(1); });
