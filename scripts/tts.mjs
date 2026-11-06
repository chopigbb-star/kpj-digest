// 기사 요약 → 읽어주기 음성(MP3). 맥미니에서 update.mjs 다음에 실행.
// - 대상: AUDIO_FROM 이후 호의 기사. 만든 지 RETAIN_DAYS 지난 음성은 삭제하고 다시 만들지 않는다.
// - 음성 파일은 별도 저장소(kpj-digest-audio)에 두고, 올릴 때마다 기록 없이 덮어써서 용량이 늘지 않게 한다.
// - 사이트가 읽는 목록: data/audio.json  { items: { [기사 id]: { file, createdAt, seconds, hash } }, expired: [id...] }
// 환경변수: EDGE_TTS(edge-tts 실행 파일), TTS_VOICE, AUDIO_DIR(음성 저장소 폴더), AUDIO_BASE_URL

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTICLES_FILE = path.join(ROOT, 'data/articles.json');
const AUDIO_JSON = path.join(ROOT, 'data/audio.json');

const AUDIO_FROM = '2026.10.01';
const RETAIN_DAYS = 30;
const EDGE_TTS = process.env.EDGE_TTS || 'edge-tts';
const VOICE = process.env.TTS_VOICE || 'ko-KR-InJoonNeural';
const RATE = process.env.TTS_RATE || '+5%';
const AUDIO_DIR = process.env.AUDIO_DIR || path.join(ROOT, '..', 'kpj-digest-audio');
const MAX_NEW = Number(process.env.TTS_MAX_NEW || 80);
const DAY = 86400e3;

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

// 읽기 좋게 단위·기호를 한글로
function speakable(s) {
  return String(s)
    .replace(/==/g, '')
    .replace(/\bvs\.?(?=\s|$)/gi, '대')
    .replace(/(\d)\s*mg\/dL\b/gi, '$1 밀리그램 퍼 데시리터') // mg보다 먼저
    .replace(/(\d)\s*㎎|(\d)\s*mg\b/gi, (m, a, b) => `${a || b} 밀리그램`)
    .replace(/(\d)\s*(?:μg|mcg|㎍)\b/gi, '$1 마이크로그램')
    .replace(/(\d)\s*mL\b|(\d)\s*ml\b/g, (m, a, b) => `${a || b} 밀리리터`)
    .replace(/(\d)\s*kg\b/gi, '$1 킬로그램')
    .replace(/(\d)\s*g\b/g, '$1 그램')
    .replace(/(\d)\s*mmHg\b/gi, '$1 밀리미터수은')
    .replace(/(\d)\s*%p\b/g, '$1 퍼센트포인트')
    .replace(/(\d)\s*%/g, '$1 퍼센트')
    .replace(/(\d)\s*[~∼]\s*(\d)/g, '$1에서 $2')
    .replace(/\bqd\b/gi, '하루 한 번')
    .replace(/\bbid\b/gi, '하루 두 번')
    .replace(/\s+/g, ' ')
    .trim();
}

function scriptOf(a) {
  const lines = [
    `대한약사저널 제${a.issueNo}호, ${a.category}.`,
    `${a.title}.`,
    a.subtitle ? `${a.subtitle}.` : '',
    a.author ? `${a.author} 글입니다.` : '',
    a.keyPoints?.length ? '핵심 세 줄입니다.' : '',
    ...(a.keyPoints || []).map((k, i) => `${i + 1}. ${k}`),
    '자세한 내용입니다.',
    ...(a.summaryPoints || [])
  ].filter(Boolean);
  return lines.map(speakable).join('\n');
}

async function durationSeconds(file) {
  try {
    const { stdout } = await run('afinfo', [file]);
    const m = stdout.match(/estimated duration: ([\d.]+)/);
    return m ? Math.round(Number(m[1])) : null;
  } catch { return null; }
}

async function git(...args) {
  const { stdout } = await run('git', args, { cwd: AUDIO_DIR });
  return stdout.trim();
}

async function main() {
  const articles = await readJson(ARTICLES_FILE, []);
  const state = await readJson(AUDIO_JSON, { items: {}, expired: [] });
  state.items ||= {};
  state.expired ||= [];
  const expired = new Set(state.expired);
  const now = Date.now();
  await fs.mkdir(AUDIO_DIR, { recursive: true });

  // 1) 한 달 지난 음성 삭제 (다시 만들지 않도록 expired에 기록)
  let removed = 0;
  for (const [id, it] of Object.entries(state.items)) {
    if (now - it.createdAt > RETAIN_DAYS * DAY) {
      await fs.rm(path.join(AUDIO_DIR, it.file), { force: true });
      delete state.items[id];
      expired.add(id);
      removed++;
    }
  }

  // 2) 새로 만들 기사: 대상 기간 + 아직 없음(또는 요약이 바뀜) + 만료된 적 없음
  const targets = articles.filter(a => a.date >= AUDIO_FROM && a.summaryPoints?.length && !expired.has(a.id));
  let made = 0;
  for (const a of targets) {
    if (made >= MAX_NEW) break;
    const text = scriptOf(a);
    const hash = crypto.createHash('sha1').update(VOICE + RATE + text).digest('hex').slice(0, 12);
    const cur = state.items[a.id];
    if (cur && cur.hash === hash) continue;
    const file = `${a.id}.mp3`;
    const out = path.join(AUDIO_DIR, file);
    const txt = path.join(AUDIO_DIR, `.${a.id}.txt`);
    try {
      await fs.writeFile(txt, text);
      await run(EDGE_TTS, ['--voice', VOICE, `--rate=${RATE}`, '-f', txt, '--write-media', out], { timeout: 5 * 60e3 });
      // 요약만 바뀐 경우 처음 만든 날짜를 유지 (보존 기간은 처음 만든 날부터)
      state.items[a.id] = { file, createdAt: cur?.createdAt || now, seconds: await durationSeconds(out), hash };
      made++;
      console.log(`음성 ${cur ? '갱신' : '생성'}: ${a.date} ${a.title} (${state.items[a.id].seconds}초)`);
    } catch (e) {
      console.warn(`음성 실패 ${a.id}: ${e.message.slice(0, 200)}`);
    } finally {
      await fs.rm(txt, { force: true });
    }
  }

  // 3) 목록에 없는 파일 정리
  const keep = new Set(Object.values(state.items).map(i => i.file));
  for (const f of await fs.readdir(AUDIO_DIR)) {
    if (f.endsWith('.mp3') && !keep.has(f)) await fs.rm(path.join(AUDIO_DIR, f), { force: true });
  }

  state.expired = [...expired].sort();
  state.voice = VOICE;
  state.baseUrl = process.env.AUDIO_BASE_URL || state.baseUrl || '';
  await fs.writeFile(AUDIO_JSON, JSON.stringify(state, null, 1) + '\n');
  console.log(`음성: 새로/갱신 ${made}개, 삭제 ${removed}개, 보관 중 ${Object.keys(state.items).length}개`);

  // 4) 음성 저장소에 올리기: 기록 없이 한 커밋으로 덮어써서 용량이 쌓이지 않게 한다
  if (!(made || removed) || process.env.TTS_NO_PUBLISH) return;
  try {
    await fs.writeFile(path.join(AUDIO_DIR, '.nojekyll'), '');
    await git('branch', '-D', 'publish').catch(() => {});
    await git('checkout', '-q', '--orphan', 'publish');
    await git('add', '-A');
    await git('-c', 'user.name=kpj-digest-bot', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit', '-q', '-m', `음성 ${new Date().toISOString().slice(0, 10)} (최근 ${RETAIN_DAYS}일)`);
    await git('branch', '-D', 'main').catch(() => {});
    await git('branch', '-m', 'main');
    await git('push', '-q', '-f', 'origin', 'main');
    await git('reflog', 'expire', '--expire=now', '--all');
    await git('gc', '-q', '--prune=now');
    console.log('음성 저장소에 올림');
  } catch (e) {
    console.warn(`음성 저장소 올리기 실패: ${e.message.slice(0, 300)}`);
  }
}

export { speakable, scriptOf };

// 직접 실행할 때만 동작 (import 할 때는 실행 안 함)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
