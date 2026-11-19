import { h } from '../../dom.js';
import { t } from '../../../i18n/index.js';
import { Action } from '../../../core/input.js';
import { formatClock, cleanSubtitle } from '../../../services/playerController.js';
import { fitAlignment, toVideo, toCue, REACTION_MS } from '../../../services/subtitleAlign.js';

/** The two zoomed bars show this much of the video around the cursor (the main progress bar stays as it is). */
export const WINDOW_MS = 120000;
/** Playing a line: from this long before it, so the voice can be heard coming. */
const LEAD_MS = 5000;
const STEP_MS = 1000; // Left / Right while the video plays
const FINE_MS = 500; // Left / Right once paused on the line
const SEEK_WAIT_MS = 500; // the video jumps once the keys stop
const TICK_MS = 200;
const SUGGEST_GAP_MS = 10 * 60000; // the next line suggested: about ten minutes from the last point (the speed needs points far apart)
const MAX_SEGMENTS = 400;

/** The window of the zoomed bars around `center` (within the video). */
export function zoomWindow(center, durationMs, size = WINDOW_MS) {
  const start = Math.max(0, Math.min(center - size / 2, Math.max(0, durationMs - size)));
  return { start, end: start + size };
}

/** The line to start from: the one at (or right after) the position, in the timing used now. */
export function lineAt(cues, videoMs, timing) {
  const cueMs = toCue(videoMs, timing);
  const i = cues.findIndex((c) => c.end >= cueMs);
  return i < 0 ? Math.max(0, cues.length - 1) : i;
}

/** A line about `gap` from `fromCueMs` (after it, or before when the film ends first): the next point suggested. */
export function suggestLine(cues, fromCueMs, gap = SUGGEST_GAP_MS) {
  if (!cues.length) return 0;
  const last = cues[cues.length - 1].start;
  const target = fromCueMs + gap <= last ? fromCueMs + gap : Math.max(0, fromCueMs - gap);
  const i = cues.findIndex((c) => c.start >= target);
  return i < 0 ? cues.length - 1 : i;
}

/**
 * The guided alignment of downloaded subtitles, over the player. Two bars above the main progress bar, zoomed on two minutes around the
 * cursor: the lines of the subtitles (segments) and the video. Steps: choose a line (Left / Right go from line to line, its text on
 * screen, the cursors of the video bars follow), OK plays the video from just before it; when the line is heard OK pauses (the moment
 * minus the time of reaction is the point), Left / Right adjust it by half a second; "Next" keeps the point. From two points the timing
 * (delay and speed) is used at once (preview) and the procedure can end; more points are optional. The points are saved one by one: the
 * procedure opened again starts from them (each can be done again).
 * deps: { root, cues, timing, points, save(points), durationMs(), getTime(), seek(ms), setPaused(paused), onPreview(fit), onClose(fit | null) }
 */
export function createSubtitleAligner({ root, cues, timing: startTiming, points: savedPoints = [], save = async () => undefined, durationMs, getTime, seek, setPaused, onPreview = () => {}, onClose }) {
  let points = savedPoints.slice();
  let fit = fitAlignment(points);
  const timingNow = () => (points.length ? fit : startTiming);
  let index = points.length ? Math.max(0, cues.findIndex((c) => c.start >= points[points.length - 1].cue)) : lineAt(cues, getTime(), startTiming);
  let phase = 'pick'; // 'pick' | 'play' | 'paused'
  let focus = 'subs'; // 'subs' | 'video' | 'panel'
  let panelIndex = 0;
  let pending = null; // { cue, video }: the point found, waiting for "Next"
  let videoCursor = toVideo(cues[index] ? cues[index].start : 0, timingNow());
  let playWindow = null;
  let seekTimer = null;
  let closed = false;

  const lineEl = h('div', { class: 'align-line' });
  const subsTrack = h('div', { class: 'align-track' });
  const subsCursor = h('div', { class: 'align-cursor' });
  const subsBar = h('div', { class: 'align-bar subs' }, h('span', { class: 'align-label', text: t('align.subtitles') }), h('div', { class: 'align-rail' }, subsTrack, subsCursor));
  const videoMarks = h('div', { class: 'align-track' });
  const videoCursorEl = h('div', { class: 'align-cursor' });
  const videoBar = h('div', { class: 'align-bar video' }, h('span', { class: 'align-label', text: t('align.video') }), h('div', { class: 'align-rail' }, videoMarks, videoCursorEl));
  const fromEl = h('span', { class: 'align-time' });
  const toEl = h('span', { class: 'align-time' });
  const bars = h('div', { class: 'align-bars' }, lineEl, subsBar, videoBar, h('div', { class: 'align-times' }, fromEl, toEl));
  const stepEl = h('div', { class: 'align-step' });
  const helpEl = h('div', { class: 'align-help' });
  const listEl = h('div', { class: 'align-points' });
  const resultEl = h('div', { class: 'align-result' });
  const backBtn = h('button', { class: 'btn align-btn', text: t('align.back') });
  const nextBtn = h('button', { class: 'btn btn-primary align-btn', text: t('align.next') });
  const doneBtn = h('button', { class: 'btn align-btn', text: t('align.finish') });
  const panel = h('div', { class: 'align-panel' }, h('div', { class: 'align-title', text: t('align.title') }), stepEl, helpEl, listEl, resultEl, h('div', { class: 'align-actions' }, backBtn, nextBtn, doneBtn));
  const el = h('div', { class: 'align-ui' }, panel, bars);
  root.appendChild(el);
  root.classList.add('aligning');
  setPaused(true);

  const cueVideo = (i) => toVideo(cues[i].start, timingNow());
  const canNext = () => phase === 'paused' && Boolean(pending);
  const canFinish = () => points.length >= 2 && fit.ok;
  const pct = (ms, win) => `${Math.max(0, Math.min(100, ((ms - win.start) / (win.end - win.start)) * 100))}%`;
  const delayText = (ms) => `${ms >= 0 ? '+' : '−'}${(Math.abs(ms) / 1000).toFixed(1)} s`;

  /** The items of the panel the focus walks: the points (to do one again), then Back, Next, Finish. */
  function panelItems() {
    const items = points.map((p, i) => ({ el: listEl.children[i], run: () => redoPoint(i), enabled: true }));
    return items.concat([
      { el: backBtn, run: goBack, enabled: true },
      { el: nextBtn, run: keepPoint, enabled: canNext() },
      { el: doneBtn, run: finish, enabled: canFinish() },
    ]);
  }

  function render() {
    if (closed) return;
    const cue = cues[index];
    lineEl.textContent = cue ? cleanSubtitle(cue.text) : '';
    const center = phase === 'pick' ? cueVideo(index) : videoCursor;
    const win = phase === 'pick' || !playWindow ? zoomWindow(center, durationMs()) : playWindow;
    fromEl.textContent = formatClock(win.start / 1000);
    toEl.textContent = formatClock(win.end / 1000);
    // The lines in the window, where they fall on the video with the timing of now.
    while (subsTrack.firstChild) subsTrack.removeChild(subsTrack.firstChild);
    const timing = timingNow();
    let drawn = 0;
    for (let i = 0; i < cues.length && drawn < MAX_SEGMENTS; i += 1) {
      const from = toVideo(cues[i].start, timing);
      const to = toVideo(cues[i].end, timing);
      if (to < win.start) continue;
      if (from > win.end) break;
      const seg = h('div', { class: i === index ? 'align-seg selected' : 'align-seg' });
      seg.style.left = pct(from, win);
      seg.style.width = `${Math.max(0.4, ((Math.min(to, win.end) - Math.max(from, win.start)) / (win.end - win.start)) * 100)}%`;
      seg.dataset.index = String(i);
      subsTrack.appendChild(seg);
      drawn += 1;
    }
    subsCursor.style.left = pct(cueVideo(index), win);
    videoCursorEl.style.left = pct(phase === 'pick' ? cueVideo(index) : videoCursor, win);
    while (videoMarks.firstChild) videoMarks.removeChild(videoMarks.firstChild);
    points.concat(pending ? [pending] : []).forEach((p) => {
      if (p.video < win.start || p.video > win.end) return;
      const mark = h('div', { class: 'align-mark' });
      mark.style.left = pct(p.video, win);
      videoMarks.appendChild(mark);
    });
    // The panel.
    stepEl.textContent = t('align.step', { step: points.length + 1 });
    helpEl.textContent = t(phase === 'pick' ? 'align.helpPick' : phase === 'play' ? 'align.helpPlay' : 'align.helpPaused');
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    points.forEach((p, i) => listEl.appendChild(h('div', { class: 'align-point', text: t('align.point', { n: i + 1, time: formatClock(p.video / 1000), delay: delayText(p.video - p.cue) }) })));
    if (points.length >= 2) {
      resultEl.textContent = fit.ok
        ? t('align.result', { delay: delayText(fit.offset), speed: fit.scale.toFixed(3) })
        : t(fit.problem === 'speed' ? 'align.badSpeed' : 'align.badPoint', { n: fit.worst + 1 });
      resultEl.classList.toggle('warning', !fit.ok);
    } else resultEl.textContent = points.length ? t('align.oneMore') : '';
    nextBtn.classList.toggle('disabled', !canNext());
    doneBtn.classList.toggle('disabled', !canFinish());
    // The focus.
    [subsBar, videoBar].forEach((bar) => bar.classList.remove('focused'));
    panelItems().forEach((item) => item.el && item.el.classList.remove('focused'));
    if (focus === 'subs') subsBar.classList.add('focused');
    else if (focus === 'video') videoBar.classList.add('focused');
    else {
      const items = panelItems();
      panelIndex = Math.max(0, Math.min(panelIndex, items.length - 1));
      if (items[panelIndex] && items[panelIndex].el) items[panelIndex].el.classList.add('focused');
    }
  }

  // While the video plays: its cursor follows it; at the end of the two minutes it stops.
  const ticker = setInterval(() => {
    if (closed || phase !== 'play' || seekTimer) return;
    videoCursor = Number(getTime()) || 0;
    if (playWindow && videoCursor >= playWindow.end) setPaused(true);
    render();
  }, TICK_MS);

  /** The video goes to `ms` once the keys stop (each jump of a stream costs a buffering). */
  function seekSoon(ms) {
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => {
      seekTimer = null;
      seek(ms);
    }, SEEK_WAIT_MS);
  }

  function chooseLine() {
    phase = 'play';
    pending = null;
    const start = Math.max(0, cueVideo(index) - LEAD_MS);
    playWindow = zoomWindow(cueVideo(index), durationMs());
    videoCursor = start;
    seek(start);
    setPaused(false);
    focus = 'video';
  }

  /** OK on the video: paused where the line is heard (minus the reaction); OK again plays on. */
  function markOrPlay() {
    if (phase === 'play') {
      setPaused(true);
      videoCursor = Math.max(0, (Number(getTime()) || videoCursor) - REACTION_MS);
      pending = { cue: cues[index].start, video: videoCursor };
      phase = 'paused';
      seekSoon(videoCursor);
    } else if (phase === 'paused') {
      pending = null;
      phase = 'play';
      setPaused(false);
    }
  }

  function moveVideo(delta) {
    if (phase === 'play') {
      videoCursor = Math.max(0, videoCursor + delta * STEP_MS);
      seekSoon(videoCursor);
    } else if (phase === 'paused' && pending) {
      videoCursor = Math.max(0, videoCursor + delta * FINE_MS);
      pending = { ...pending, video: videoCursor };
      seekSoon(videoCursor);
    }
  }

  function backToPick() {
    phase = 'pick';
    pending = null;
    playWindow = null;
    setPaused(true);
    focus = 'subs';
  }

  async function persist() {
    fit = fitAlignment(points);
    await save(points).catch(() => undefined);
    if (points.length >= 2 && fit.ok) onPreview(fit); // the subtitles already follow the points
  }

  function keepPoint() {
    if (!canNext()) return;
    points.push(pending);
    points.sort((a, b) => a.cue - b.cue);
    const last = pending.cue;
    persist();
    backToPick();
    index = suggestLine(cues, last);
    panelIndex = 0;
  }

  function redoPoint(i) {
    const point = points[i];
    points.splice(i, 1);
    persist();
    backToPick();
    index = Math.max(0, cues.findIndex((c) => c.start >= point.cue));
  }

  /** "Back": from the video to the choice of the line; from the choice the last point is done again; with none the procedure ends. */
  function goBack() {
    if (phase !== 'pick') backToPick();
    else if (points.length) redoPoint(points.length - 1);
    else close(null);
  }

  function finish() {
    if (!canFinish()) return;
    close(fit);
  }

  function close(result) {
    if (closed) return;
    closed = true;
    clearInterval(ticker);
    clearTimeout(seekTimer);
    el.remove();
    root.classList.remove('aligning');
    onClose(result);
  }

  // Pointer: a line on the bar of the subtitles, a moment on the bar of the video, the buttons of the panel.
  subsTrack.addEventListener('click', (event) => {
    const i = Number(event.target && event.target.dataset ? event.target.dataset.index : NaN);
    if (!Number.isFinite(i)) return;
    if (phase !== 'pick') backToPick();
    index = i;
    focus = 'subs';
    render();
  });
  videoBar.addEventListener('click', (event) => {
    if (phase === 'pick' || !playWindow) return;
    const rail = videoBar.querySelector('.align-rail').getBoundingClientRect();
    const at = playWindow.start + ((event.clientX - rail.left) / Math.max(1, rail.width)) * (playWindow.end - playWindow.start);
    videoCursor = Math.max(0, at);
    if (pending) pending = { ...pending, video: videoCursor };
    focus = 'video';
    seekSoon(videoCursor);
    render();
  });
  [backBtn, nextBtn, doneBtn].forEach((btn) =>
    btn.addEventListener('click', () => {
      const item = panelItems().find((it) => it.el === btn);
      if (item && item.enabled) item.run();
      render();
    }),
  );
  listEl.addEventListener('click', (event) => {
    const i = Array.prototype.indexOf.call(listEl.children, event.target);
    if (i >= 0) redoPoint(i);
    render();
  });

  render();

  return {
    /** The keys while the procedure is open (all of them: the player's own are not used). */
    handle(action) {
      if (closed) return false;
      if (focus === 'subs') {
        if (action === Action.LEFT || action === Action.RIGHT) {
          if (phase !== 'pick') backToPick();
          index = Math.max(0, Math.min(cues.length - 1, index + (action === Action.RIGHT ? 1 : -1)));
        } else if (action === Action.ENTER) chooseLine();
        else if (action === Action.UP) focus = 'panel';
        else if (action === Action.DOWN && phase !== 'pick') focus = 'video';
      } else if (focus === 'video') {
        if (action === Action.LEFT || action === Action.RIGHT) moveVideo(action === Action.RIGHT ? 1 : -1);
        else if (action === Action.ENTER) markOrPlay();
        else if (action === Action.UP) focus = 'subs';
      } else {
        const items = panelItems();
        if (action === Action.LEFT) panelIndex = Math.max(0, panelIndex - 1);
        else if (action === Action.RIGHT) panelIndex = Math.min(items.length - 1, panelIndex + 1);
        else if (action === Action.DOWN) focus = phase === 'pick' ? 'subs' : 'video';
        else if (action === Action.ENTER && items[panelIndex] && items[panelIndex].enabled) items[panelIndex].run();
      }
      render();
      return true;
    },
    /** The Back key: the procedure ends; the points stay saved, and from two good ones their timing is used. */
    back() {
      close(canFinish() ? fit : null);
      return true;
    },
    /** Where the main progress bar shows the cursor (the line chosen, or the video), in ms. */
    mainCursor: () => (closed ? null : phase === 'pick' && cues[index] ? cueVideo(index) : videoCursor),
    destroy: () => close(null),
    isOpen: () => !closed,
  };
}
