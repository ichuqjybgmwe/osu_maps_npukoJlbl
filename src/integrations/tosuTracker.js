// Логика поверх кадров Tosu (/websocket/v2): отслеживает попытки и
// завершённые результаты. Не знает про сеть и базу — только кадры на входе
// и события на выходе, поэтому полностью покрыта тестами.
import { EventEmitter } from 'node:events';
import { modsToString, modsRate } from '../pp/mods.js';

const PLAY = 'play';
const RESULTS = 'resultScreen';

export function normalizeTosuResult(frame) {
  const r = frame.resultsScreen || {};
  const h = r.hits || {};
  const b = frame.beatmap || {};
  const modsArr = r.mods?.array ?? r.mods?.name ?? r.mods?.number ?? '';
  return {
    source: 'tosu',
    apiScoreId: r.scoreId > 0 ? r.scoreId : null,
    beatmapMd5: b.checksum || null,
    beatmapId: b.id > 0 ? b.id : null,
    beatmapsetId: b.set > 0 ? b.set : null,
    beatmapTitle: b.title ? `${b.artist} - ${b.title} [${b.version}]` : null,
    mode: r.mode?.number ?? b.mode?.number ?? 0,
    playerName: r.playerName || r.name || null,
    userId: null,
    score: Number(r.score) || 0,
    accuracy: Number(r.accuracy) || 0,
    maxCombo: Number(r.maxCombo) || 0,
    n300: h['300'] || 0,
    n100: h['100'] || 0,
    n50: h['50'] || 0,
    nmiss: h['0'] || 0,
    ngeki: h.geki || 0,
    nkatu: h.katu || 0,
    sliderEndHits: h.sliderEndHits ?? null,
    smallTickHits: h.smallTickHits ?? null,
    largeTickHits: h.largeTickHits ?? null,
    mods: modsToString(modsArr),
    modsJson: Array.isArray(r.mods?.array) ? r.mods.array : null,
    rate: r.mods?.rate || modsRate(modsArr),
    rank: r.rank || null,
    passed: r.rank ? r.rank !== 'F' : true,
    pp: r.pp?.current ?? null,
    ppFc: r.pp?.fc ?? null,
    lazer: frame.client === 'lazer',
    playedAt: parseTosuDate(r.createdAt),
    raw: { resultsScreen: r, beatmap: { checksum: b.checksum, id: b.id, set: b.set }, client: frame.client },
  };
}

function parseTosuDate(s) {
  if (!s) return new Date().toISOString();
  const d = new Date(s);
  return Number.isNaN(d.getTime()) || d.getFullYear() < 2007 ? new Date().toISOString() : d.toISOString();
}

function resultIsComplete(frame) {
  const r = frame.resultsScreen;
  if (!r) return false;
  const h = r.hits || {};
  const total = (h['300'] || 0) + (h['100'] || 0) + (h['50'] || 0) + (h['0'] || 0) + (h.geki || 0) + (h.katu || 0);
  return total > 0 && Number(r.score) >= 0 && !!frame.beatmap?.checksum;
}

const sameName = (a, b) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

export class TosuTracker extends EventEmitter {
  /** @param {{ getOwnName?: () => string|null }} opts */
  constructor({ getOwnName = () => null } = {}) {
    super();
    this.getOwnName = getOwnName;
    this.state = null;
    this.attempt = null;      // текущая попытка
    this.lastPlay = null;     // последний снимок play для завершения попытки
    this.cameFromPlay = null; // checksum карты, с которой пришли на экран результатов
    this.resultHandled = false;
    this.lastFrame = null;
  }

  ownName(frame) {
    return this.getOwnName() || frame?.profile?.name || null;
  }

  /** Обработать очередной кадр Tosu. */
  process(frame, now = new Date()) {
    if (!frame || typeof frame !== 'object' || !frame.state) return;
    this.lastFrame = frame;
    const next = frame.state.name;
    const prev = this.state;

    if (prev !== next) {
      if (prev === PLAY) this.finishAttempt(next === RESULTS ? 'pass' : null, now);
      if (next === PLAY) this.startAttempt(frame, now);
      if (next === RESULTS) {
        this.resultHandled = false;
      } else {
        this.cameFromPlay = null;
      }
      this.state = next;
      this.emit('state', { from: prev, to: next });
    }

    if (next === PLAY) this.trackPlay(frame, now);
    if (next === RESULTS && !this.resultHandled && resultIsComplete(frame)) this.handleResult(frame);
  }

  isReplay(frame) {
    const own = this.ownName(frame);
    const player = frame.play?.playerName;
    return !!own && !!player && !sameName(own, player);
  }

  startAttempt(frame, now) {
    const b = frame.beatmap || {};
    const replay = this.isReplay(frame);
    this.attempt = {
      beatmapMd5: b.checksum || null,
      beatmapId: b.id > 0 ? b.id : null,
      mode: frame.play?.mode?.number ?? b.mode?.number ?? 0,
      mods: modsToString(frame.play?.mods?.array ?? frame.play?.mods?.name ?? ''),
      startedAt: now.toISOString(),
      playerName: frame.play?.playerName || null,
      replay,
    };
    this.lastPlay = null;
    this.cameFromPlay = null;
  }

  trackPlay(frame, now) {
    if (!this.attempt) this.startAttempt(frame, now);
    const p = frame.play || {};
    const t = frame.beatmap?.time || {};
    const snap = {
      live: t.live ?? 0,
      first: t.firstObject ?? 0,
      last: t.lastObject ?? 0,
      score: p.score ?? 0,
      accuracy: p.accuracy ?? null,
      maxCombo: p.combo?.max ?? 0,
      nmiss: p.hits?.['0'] ?? 0,
      failed: !!p.failed,
      pp: p.pp?.current ?? null,
      checksum: frame.beatmap?.checksum,
      playerName: p.playerName || this.attempt.playerName,
    };
    if (p.playerName && !this.attempt.playerName) {
      this.attempt.playerName = p.playerName;
      this.attempt.replay = this.isReplay(frame);
    }
    // Быстрый рестарт: игра остаётся в состоянии play, но время и счёт сбрасываются.
    const prev = this.lastPlay;
    if (prev && prev.checksum === snap.checksum && prev.live - snap.live > 1500 && snap.score < prev.score) {
      this.finishAttempt('retry', now);
      this.startAttempt(frame, now);
    } else if (prev && prev.checksum !== snap.checksum) {
      this.finishAttempt('quit', now);
      this.startAttempt(frame, now);
    }
    this.lastPlay = snap;
    this.emit('live', snap);
  }

  finishAttempt(outcome, now) {
    const a = this.attempt;
    const s = this.lastPlay;
    this.attempt = null;
    if (!a) return;
    if (!s || s.live <= s.first) {
      // Карта даже не началась — это не попытка.
      if (outcome !== 'pass') return;
    }
    const span = s ? Math.max(1, s.last - s.first) : 1;
    const progress = s ? Math.max(0, Math.min(1, (s.live - s.first) / span)) : null;
    const resolved = outcome || (s?.failed ? 'fail' : progress != null && progress >= 0.999 ? 'pass' : 'quit');
    if (resolved === 'pass') this.cameFromPlay = a.beatmapMd5;
    if (a.replay) return; // повтор чужой игры — не наша попытка
    this.emit('attempt', {
      ...a,
      endedAt: now.toISOString(),
      outcome: resolved,
      progress: resolved === 'pass' ? 1 : progress,
      accuracy: s?.accuracy ?? null,
      maxCombo: s?.maxCombo ?? null,
      nmiss: s?.nmiss ?? null,
      score: s?.score ?? null,
      ppCurrent: s?.pp ?? null,
      playerName: s?.playerName || a.playerName,
    });
  }

  handleResult(frame) {
    this.resultHandled = true;
    const score = normalizeTosuResult(frame);
    const own = this.ownName(frame);
    const fromPlay = this.cameFromPlay && this.cameFromPlay === score.beatmapMd5;
    // Сохраняем только свои результаты: либо имя совпадает с нашим, либо
    // мы видели саму игру (имя игрока неизвестно — офлайн-режим).
    let accept;
    if (own) accept = sameName(own, score.playerName);
    else accept = !!fromPlay;
    if (!accept) {
      this.emit('ignoredResult', { reason: own ? 'чужой результат (повтор/таблица)' : 'результат открыт не после игры', playerName: score.playerName });
      return;
    }
    this.emit('result', { ...score, fromPlay: !!fromPlay });
  }
}
