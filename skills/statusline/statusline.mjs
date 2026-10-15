#!/usr/bin/env node
// anvil 的参考 statusline：输入框下方一行，模型 effort · 上下文 · 缓存。
// 目录名、git、5h、7d、花费由 anvil 画在输入框上方，这里不重复。
// 由 /anvil:statusline 照着用户的偏好改写后装到 ~/.claude/statusline.mjs；仓库里这份是默认样子。
// 缓存段：命中率、会续期 / 到点过期 / 已失效。命中率和过期时刻取 stdin 的 prompt_cache；会不会自动续期、
// 续期出没出错读 anvil 写的 <CLAUDE_CONFIG_DIR 或 ~/.claude>/anvil/sessions/<session_id>.json（{ renews, error, expiresAt, at }）。
// 不开 refreshInterval：expires_at 到点时 Claude Code 会自动重跑本脚本。
// 配色、Nerd Font 图标和 anvil hooks/style.ts 同一套。

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// ---------- 配色 ----------
const fg = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
};
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const C = {
  text: fg('#d4dae3'),     // 读数 — 亮灰白
  model: fg('#d49a8a'),    // 模型 — 柔桃
  barTrack: fg('#3a4150'), // 进度条底轨
  sep: fg('#4b5263'),      // 分隔点
  label: fg('#6b7280'),    // 次要标签
  icon: fg('#7a8194'),     // 图标
  ok: fg('#8fbf7f'),
  warn: fg('#d7bd6f'),
  high: fg('#d79a6f'),     // 80-90% — 柔橙
  crit: fg('#d76f6f'),     // ≥90% — 柔红
  renew: fg('#7fbfae'),    // 自动续期 — 青（和花费同色系）
};
// ---------- 热度渐变 ----------
// 在 OKLab 里插值，渐变不发灰、亮度均匀（同 anvil hooks/color.ts）
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const gam = (v) => { const c = Math.min(1, Math.max(0, v)); return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055); };
const toLab = (h) => {
  const [r, g, b] = hexRgb(h).map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
};
const fromLab = ([L, a, b]) => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return `#${rgb.map((v) => Math.round(gam(v)).toString(16).padStart(2, '0')).join('')}`;
};
const mix = (a, b, t) => { const A = toLab(a), B = toLab(b); return fromLab(A.map((v, i) => v + (B[i] - v) * t)); };
// 45% 以前绿，往后依次过渡到黄、橙、红；到 60/80/90 正好是原来四档的颜色
const HEAT = [[0, '#8fbf7f'], [45, '#8fbf7f'], [60, '#d7bd6f'], [80, '#d79a6f'], [90, '#d76f6f']];
const heat = (pct) => {
  if (pct <= HEAT[0][0]) return HEAT[0][1];
  for (let i = 1; i < HEAT.length; i++) {
    const [p0, c0] = HEAT[i - 1], [p1, c1] = HEAT[i];
    if (pct <= p1) return mix(c0, c1, (pct - p0) / (p1 - p0));
  }
  return HEAT[HEAT.length - 1][1];
};
const levelColor = (pct) => fg(heat(pct));
// 进度条：每格按它在条上的位置取色（学 btop），填到哪最后一格就和百分比同色
const heatBar = (pct, W) => {
  const filled = Math.round((pct / 100) * W);
  let s = '';
  for (let i = 0; i < filled; i++) s += fg(heat(((i + 1) / filled) * pct)) + '━';
  return `${s}${C.barTrack}${'─'.repeat(W - filled)}${RESET}`;
};

// Nerd Font 图标（和 anvil hooks/style.ts 的 ICON 同一套）；图标后留一个空格
const I = { model: '\u{F4BC}', cache: '\u{F01BC}', ctx: '\u{F035B}', renew: '\u{F006A}', clock: '\u{F0150}', expired: '\u{F0026}' };
const SEP = `  ${C.sep}·${RESET}  `; // 段间，可见宽度 5
const DOT = ` ${C.sep}·${RESET} `; // 段内，可见宽度 3

// ---------- 工具 ----------
const ANSI_RE = /\x1b\[[0-9;]*m/g;
// 估算可见宽度：CJK / 全角按 2，其余按 1
const vw = (s) => {
  let w = 0;
  for (const ch of s.replace(ANSI_RE, '')) {
    const c = ch.codePointAt(0);
    w += (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) ||
         (c >= 0xff00 && c <= 0xff60) || (c >= 0x3000 && c <= 0x303f) ? 2 : 1;
  }
  return w;
};
const join = (segs) => segs.filter(Boolean).join(SEP);

// ---------- 读取 stdin ----------
let data = {};
try {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  data = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
} catch { /* 各段自行降级 */ }

const now = Date.now();

// ---------- 模型 effort ----------
const model = data.model?.display_name || data.model?.id;
const effort = typeof data.effort === 'string' ? data.effort : data.effort?.level;
// effort 档位色阶：一眼感知当前烧 token 的火力；max 加粗红，未知档位灰色兜底
const EFFORT_COLOR = { low: C.ok, medium: C.warn, high: C.high, xhigh: C.crit, max: C.crit };
const effortMark = effort
  ? ` ${effort === 'max' ? BOLD : ''}${EFFORT_COLOR[effort] ?? C.label}${effort}${RESET}`
  : '';
const segModel = model ? `${C.model}${I.model} ${model}${RESET}${effortMark}` : null;

// ---------- 上下文 ----------
const ctxPct = data.context_window?.used_percentage;
let segCtx = null;
let segCtxNoBar = null;
if (typeof ctxPct === 'number' && Number.isFinite(ctxPct)) {
  const pct = Math.min(100, Math.max(0, Math.round(ctxPct)));
  const col = levelColor(pct);
  const label = `${C.icon}${I.ctx}${RESET} ${C.label}ctx${RESET}`;
  segCtxNoBar = `${label} ${col}${pct}%${RESET}`;
  segCtx = `${label} ${heatBar(pct, 10)} ${col}${pct}%${RESET}`;
}

// ---------- 缓存 ----------
// anvil 写的保活状态：这个会话会不会自动续期、续期出没出错。读不到（没装 anvil、还没写）就当不会续
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
const sessionsDir = path.join(configDir, 'anvil', 'sessions');
let anvil = null;
if (typeof data.session_id === 'string' && data.session_id) {
  try { anvil = JSON.parse(readFileSync(path.join(sessionsDir, `${data.session_id}.json`), 'utf-8')); } catch { /* 没有 */ }
}
// 顺手清掉 7 天没动过的状态文件（anvil 只写不删）；百分之一的机会做一次，不拖慢每次刷新
if (Math.random() < 0.01 && existsSync(sessionsDir)) {
  try {
    for (const name of readdirSync(sessionsDir)) {
      const file = path.join(sessionsDir, name);
      if (now - statSync(file).mtimeMs > 7 * 86400000) unlinkSync(file);
    }
  } catch { /* 下次再清 */ }
}

const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// 没有请求时（prompt_cache 是空的）不画。时间一律绝对时刻：statusline 空闲时不定时重跑，相对倒计时会停住
let segCache = null;
let segCacheShort = null; // 窄时：命中率和状态，不写"keepalive"
{
  const pc = data.prompt_cache;
  if (pc && typeof pc.requests === 'number' && pc.requests > 0) {
    const ratio = typeof pc.hit_ratio === 'number' ? pc.hit_ratio : null;
    // 命中率：80% 以上绿，50–80% 黄，以下红；图标跟着同色
    const hitCol = ratio === null ? C.label : ratio < 0.5 ? C.crit : ratio < 0.8 ? C.warn : C.ok;
    const hit = `${hitCol}${I.cache} ${ratio === null ? '—' : `${Math.round(ratio * 100)}%`}${RESET}`;
    const exp = typeof pc.expires_at === 'number' ? new Date(pc.expires_at * 1000) : null;
    const warm = pc.warm === true && exp !== null && exp.getTime() > now;
    let state;
    let stateShort;
    // 有效期：会自动续是绿（不用管），只到某个时刻是黄（要留意），已失效是红
    if (warm && anvil?.renews) {
      state = `${C.ok}warm${RESET}${DOT}${C.renew}${I.renew} keepalive${RESET}`;
      stateShort = `${C.ok}warm${RESET} ${C.renew}${I.renew}${RESET}`;
    } else if (warm) {
      state = stateShort = `${C.warn}${I.clock} expires ${BOLD}${hhmm(exp)}${RESET}`;
    } else {
      state = stateShort = `${C.crit}${I.expired} expired${exp ? ` ${hhmm(exp)}` : ''}${RESET}`;
    }
    const error = anvil?.error ? `${DOT}${C.crit}${I.expired} keepalive failed${RESET}` : '';
    segCache = `${hit}${DOT}${state}${error}`;
    segCacheShort = `${hit}${DOT}${stateShort}${error}`;
  }
}

// ---------- 自适应组装 ----------
const cols = parseInt(process.env.COLUMNS ?? '', 10) || 120;
const budget = cols - 2; // 右侧留 2 列呼吸位

// 逐级方案，从最丰满到最精简，取第一个放得下的
const candidates = [
  () => join([segModel, segCtx, segCache]),
  () => join([segModel, segCtxNoBar, segCache]),
  () => join([segModel, segCtxNoBar, segCacheShort]),
  () => join([segModel, segCacheShort]),
];

let out = candidates[candidates.length - 1]();
for (const build of candidates) {
  const s = build();
  if (vw(s) <= budget) { out = s; break; }
}
process.stdout.write(out + RESET);
