import { h } from '../../dom.js';
import { t } from '../../../i18n/index.js';
import { Action } from '../../../core/input.js';
import { formatClock, cleanSubtitle } from '../../../services/playerController.js';
import { cueAt } from '../../../services/openSubtitles.js';
import { fitAlignment, toVideo, toCue } from '../../../services/subtitleAlign.js';
import { createButton } from '../../atoms/button.js';
import { createListRow } from '../../atoms/listRow.js';

/** The two zoomed bars show this much of the video around the cursor (the main progress bar stays as it is). */
export const WINDOW_MS = 120000;
/** The points needed to end the procedure (delay and speed). */
export const MIN_POINTS = 2;
const LEAD_MS = 5000; // playing the portion: from this long before the anchor
const STEP_MS = 500; // Left / Right on the video bar move the anchor by this much (a key held: faster, see dragStep)
const HOLD_MS = 300; // presses closer than this are a key held down
const SEEK_WAIT_MS = 500; // the video jumps once the keys stop
const TICK_MS = 200;
const SUGGEST_GAP_MS = 10 * 60000; // the next line suggested: about ten minutes from the last point (the speed needs points far apart)
const MAX_SEGMENTS = 400;

/** How far one press moves the anchor: half a second, more and more while the key is held (up to 10 s). */
export function dragStep(held) {
  if (held < 4) return STEP_MS;
  if (held < 10) return 2 * STEP_MS;
  if (held < 20) return 6 * STEP_MS;
  return 20 * STEP_MS;
}

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
 * The guided alignment of downloaded subtitles, over the player. Above the main progress bar (which stays as it is) two bars zoomed on two
 * minutes around the cursor: the lines of the subtitles (segments) and the video. At the top right the panel: how many points are defined
 * (red until MIN_POINTS, then green), what to do, the points (each with "Edit" and "Remove"), "Add point" and "Conclude".
 * A point: on the bar of the subtitles Left / Right choose a line (its text on screen), OK confirms it (its cursor turns green) and the
 * focus goes to the bar of the video, where the anchor (green) is the moment of the video matched with that line: Left / Right move it
 * (the picture follows, from the anchor's frame); OK plays video and subtitles together with that alignment, from just before the anchor to
 * the end of the zoomed portion (OK again, Back or the end: back to the anchor's frame). "Add point" (on as soon as the line is confirmed)
 * keeps it and starts the next one. Back: from the video bar to the subtitles, from the subtitles to the panel, from the panel the procedure
 * ends (only the points added stay). The points are saved one by one; opened again it starts from them.
 * deps: { root, cues, timing, points, save(points), durationMs(), getTime(), seek(ms), setPaused(paused), onPreview(fit), onClose(fit | null) }
 */
export function createSubtitleAligner({ root, cues, timing: startTiming, points: savedPoints = [], save = async () => undefined, durationMs, getTime, seek, setPaused, onPreview = () => {}, onClose }) {
  let points = savedPoints.slice().sort((a, b) => a.cue - b.cue);
  let fit = fitAlignment(points);
  const timingNow = () => (points.length ? fit : startTiming);
  const startPosition = Number(getTime()) || 0; // where the video was: back there at the end
  // The line to start from: about ten minutes after the last point; without points the start of the film.
  let index = points.length ? suggestLine(cues, points[points.length - 1].cue) : 0;
  let confirmed = false; // the line is chosen (its cursor green): the video bar sets its anchor
  let anchor = null; // the moment of the video matched with the line (ms)
  let playing = false; // the portion plays (video and subtitles together)
  let playWindow = null;
  let playhead = 0;
  let focus = 'subs'; // 'subs' | 'video' | 'panel'
  let panelArea = 'buttons'; // 'buttons' (Add point, Conclude) | 'points' (the list: Edit, Remove)
  let buttonIndex = 0;
  let pointIndex = 0;
  let pointButton = 0; // 0 Edit, 1 Remove
  let seekTimer = null;
  let dragWindow = null; // while the anchor is being moved the bars stay still; at the end they center on it again
  let lastMove = 0;
  let held = 0; // presses in a row of a key held down
  let closed = false;

  // The timing with the point being made (the anchor matched with the line): what the bars and the portion played show.
  const candidateTiming = () => (confirmed && anchor !== null ? fitAlignment(points.concat([{ cue: cues[index].start, video: anchor }])) : timingNow());
  const canAdd = () => confirmed && anchor !== null;
  const canConclude = () => points.length >= MIN_POINTS && fit.ok;

  const lineEl = h('div', { class: 'align-line' });
  const subsTrack = h('div', { class: 'align-track' });
  const subsCursor = h('div', { class: 'align-cursor' });
  const subsBar = h('div', { class: 'align-bar subs' }, h('span', { class: 'align-label', text: t('align.subtitles') }), h('div', { class: 'align-rail' }, subsTrack, subsCursor));
  const anchorEl = h('div', { class: 'align-anchor' });
  const playheadEl = h('div', { class: 'align-cursor' });
  const videoBar = h('div', { class: 'align-bar video' }, h('span', { class: 'align-label', text: t('align.video') }), h('div', { class: 'align-rail line' }, anchorEl, playheadEl));
  const fromEl = h('span', { class: 'align-time' });
  const toEl = h('span', { class: 'align-time' });
  const bars = h('div', { class: 'align-bars' }, lineEl, subsBar, videoBar, h('div', { class: 'align-times' }, fromEl, toEl));
  const countEl = h('div', { class: 'align-count' });
  const listEl = h('div', { class: 'list align-points' });
  const warnEl = h('div', { class: 'align-warning' });
  const addBtn = createButton({ label: t('align.add'), className: 'align-btn' });
  const concludeBtn = createButton({ label: t('align.conclude'), variant: 'primary', className: 'align-btn' });
  const panel = h(
    'div',
    { class: 'align-panel' },
    h('div', { class: 'align-title', text: t('align.title') }),
    countEl,
    h('div', { class: 'align-help', text: t('align.help') }),
    listEl,
    warnEl,
    h('div', { class: 'align-actions' }, addBtn, concludeBtn),
  );
  const el = h('div', { class: 'align-ui' }, panel, bars);
  root.appendChild(el);
  root.classList.add('aligning');
  setPaused(true);

  const pct = (ms, win) => `${Math.max(0, Math.min(100, ((ms - win.start) / (win.end - win.start)) * 100))}%`;
  const panelButtons = () => [
    { el: addBtn, run: addPoint, enabled: canAdd() },
    { el: concludeBtn, run: conclude, enabled: canConclude() },
  ];
  let pointRows = []; // [{ el, edit, remove }]

  function renderPoints() {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    pointRows = points.map((p, i) => {
      // Icon buttons with their tooltip, as everywhere: Edit, and Remove as the remove buttons of Settings.
      const edit = createButton({ label: t('align.edit'), icon: 'edit', iconOnly: true, className: 'panel-button align-small', tipDir: 'down' });
      const remove = createButton({ label: t('align.remove'), icon: 'remove', variant: 'danger', iconOnly: true, className: 'panel-button align-small', tipDir: 'down' });
      const row = createListRow({ label: t('align.point', { n: i + 1, time: formatClock(p.video / 1000) }), valueEl: h('span', { class: 'align-row-actions' }, edit, remove), className: 'align-point' });
      edit.addEventListener('click', () => { editPoint(i); render(); });
      remove.addEventListener('click', () => { removePoint(i); render(); });
      listEl.appendChild(row.el);
      return { el: row.el, edit, remove };
    });
  }

  function render() {
    if (closed) return;
    const timing = candidateTiming();
    const cueVideo = toVideo(cues[index].start, timing);
    // The line on screen: while the portion plays, the one of the moment (with the alignment being made); otherwise the one chosen.
    if (playing) {
      const cue = cueAt(cues, toCue(playhead, timing));
      lineEl.textContent = cue ? cleanSubtitle(cue.text) : '';
    } else lineEl.textContent = cleanSubtitle(cues[index].text);
    const win = playing && playWindow ? playWindow : dragWindow || zoomWindow(confirmed && anchor !== null ? anchor : cueVideo, durationMs());
    fromEl.textContent = formatClock(win.start / 1000);
    toEl.textContent = formatClock(win.end / 1000);
    while (subsTrack.firstChild) subsTrack.removeChild(subsTrack.firstChild);
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
    subsCursor.style.left = pct(cueVideo, win);
    subsCursor.classList.toggle('confirmed', confirmed);
    anchorEl.style.display = confirmed && anchor !== null ? '' : 'none';
    if (anchor !== null) anchorEl.style.left = pct(anchor, win);
    playheadEl.style.display = playing ? '' : 'none';
    playheadEl.style.left = pct(playhead, win);
    // The panel: how many points (red until enough, then green), the points, a problem if any, the buttons.
    const enough = points.length >= MIN_POINTS;
    countEl.textContent = enough ? t('align.countDone', { count: points.length }) : t('align.count', { count: points.length, min: MIN_POINTS });
    countEl.classList.toggle('done', enough);
    renderPoints();
    warnEl.textContent = enough && !fit.ok ? t(fit.problem === 'speed' ? 'align.badSpeed' : 'align.badPoint', { n: fit.worst + 1 }) : '';
    addBtn.classList.toggle('disabled', !canAdd());
    concludeBtn.classList.toggle('disabled', !canConclude());
    // The focus.
    [subsBar, videoBar, addBtn, concludeBtn].forEach((node) => node.classList.remove('focused'));
    if (focus === 'subs') subsBar.classList.add('focused');
    else if (focus === 'video') videoBar.classList.add('focused');
    else if (panelArea === 'points' && pointRows.length) {
      pointIndex = Math.max(0, Math.min(pointIndex, pointRows.length - 1));
      (pointButton ? pointRows[pointIndex].remove : pointRows[pointIndex].edit).classList.add('focused');
    } else {
      panelArea = 'buttons';
      panelButtons()[buttonIndex].el.classList.add('focused');
    }
  }

  // While the portion plays: its cursor and the line of the moment follow the video; at the end, back to the anchor.
  const ticker = setInterval(() => {
    if (closed || !playing) return;
    playhead = Number(getTime()) || playhead;
    if (playWindow && playhead >= playWindow.end) stopPortion();
    render();
  }, TICK_MS);

  /** The video goes to `ms` once the keys stop (each jump of a stream costs a buffering). */
  function seekSoon(ms, recenter = false) {
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => {
      seekTimer = null;
      seek(ms);
      // The end of the move: the bars center on the anchor again (its frame on screen).
      if (recenter && dragWindow) {
        dragWindow = null;
        held = 0;
        render();
      }
    }, SEEK_WAIT_MS);
  }

  /** OK on a line: chosen (green); the anchor starts where it falls with the alignment of now; the video bar takes the focus. */
  function confirmLine() {
    confirmed = true;
    anchor = Math.max(0, toVideo(cues[index].start, timingNow()));
    focus = 'video';
    seekSoon(anchor); // the picture of the anchor
  }

  function chooseLine(delta) {
    if (playing) stopPortion();
    index = Math.max(0, Math.min(cues.length - 1, index + delta));
    confirmed = false;
    anchor = null;
  }

  /** OK on the video bar: video and subtitles play together (this alignment) to the end of the zoomed portion. */
  function playPortion() {
    if (!canAdd()) return;
    clearTimeout(seekTimer);
    seekTimer = null;
    dragWindow = null; // the bars center on the anchor again
    playWindow = zoomWindow(anchor, durationMs());
    playhead = Math.max(playWindow.start, anchor - LEAD_MS);
    playing = true;
    seek(playhead);
    setPaused(false);
  }

  /** The portion stops: the picture goes back to the anchor. */
  function stopPortion() {
    playing = false;
    playWindow = null;
    setPaused(true);
    if (anchor !== null) seek(anchor);
  }

  /** Left / Right on the video bar: the anchor moves, faster while the key is held; the bars stay still until the keys stop. */
  function moveAnchor(delta) {
    if (!canAdd()) return;
    if (playing) stopPortion();
    const now = Date.now();
    held = now - lastMove < HOLD_MS ? held + 1 : 0;
    lastMove = now;
    if (!dragWindow) dragWindow = zoomWindow(anchor, durationMs());
    anchor = Math.max(0, Math.min(durationMs() || Infinity, anchor + delta * dragStep(held)));
    seekSoon(anchor, true);
  }

  async function persist() {
    fit = fitAlignment(points);
    await save(points).catch(() => undefined);
    if (points.length >= MIN_POINTS && fit.ok) onPreview(fit); // the subtitles already follow the points
  }

  /** "Add point": the line and its anchor join the points; the next point starts on the bar of the subtitles. */
  function addPoint() {
    if (!canAdd()) return;
    if (playing) stopPortion();
    const last = cues[index].start;
    points.push({ cue: last, video: anchor });
    points.sort((a, b) => a.cue - b.cue);
    persist();
    confirmed = false;
    anchor = null;
    index = suggestLine(cues, last);
    focus = 'subs';
  }

  /** "Edit": the point leaves the list and is the one being made again (its line chosen, its anchor), on the video bar. */
  function editPoint(i) {
    const point = points[i];
    if (!point) return;
    if (playing) stopPortion();
    points.splice(i, 1);
    persist();
    index = Math.max(0, cues.findIndex((c) => c.start >= point.cue));
    confirmed = true;
    anchor = point.video;
    focus = 'video';
    seekSoon(anchor);
  }

  function removePoint(i) {
    if (!points[i]) return;
    points.splice(i, 1);
    persist();
    if (!points.length) {
      panelArea = 'buttons';
      if (!confirmed) index = 0; // no points left: from the start of the film again
    }
  }

  function conclude() {
    if (!canConclude()) return;
    close(fit);
  }

  /** The end: the video back where it was; the timing of the points when there are enough good ones. */
  function close(result) {
    if (closed) return;
    closed = true;
    clearInterval(ticker);
    clearTimeout(seekTimer);
    el.remove();
    root.classList.remove('aligning');
    seek(startPosition);
    onClose(result);
  }

  // Pointer: a line on the bar of the subtitles, a moment on the bar of the video (the anchor), the buttons of the panel.
  subsTrack.addEventListener('click', (event) => {
    const i = Number(event.target && event.target.dataset ? event.target.dataset.index : NaN);
    if (!Number.isFinite(i)) return;
    chooseLine(i - index);
    focus = 'subs';
    render();
  });
  videoBar.addEventListener('click', (event) => {
    if (!canAdd()) return;
    const rail = videoBar.querySelector('.align-rail').getBoundingClientRect();
    const win = zoomWindow(anchor, durationMs());
    if (playing) stopPortion();
    anchor = Math.max(0, win.start + ((event.clientX - rail.left) / Math.max(1, rail.width)) * (win.end - win.start));
    focus = 'video';
    seekSoon(anchor);
    render();
  });
  [addBtn, concludeBtn].forEach((btn) =>
    btn.addEventListener('click', () => {
      const item = panelButtons().find((it) => it.el === btn);
      if (item && item.enabled) item.run();
      render();
    }),
  );

  render();

  return {
    /** The keys while the procedure is open (all of them: the player's own are not used). */
    handle(action) {
      if (closed) return false;
      if (focus === 'subs') {
        if (action === Action.LEFT || action === Action.RIGHT) chooseLine(action === Action.RIGHT ? 1 : -1);
        else if (action === Action.ENTER) confirmLine();
        else if (action === Action.UP) {
          focus = 'panel';
          panelArea = 'buttons';
          buttonIndex = canAdd() ? 0 : canConclude() ? 1 : 0;
        } else if (action === Action.DOWN && canAdd()) focus = 'video';
      } else if (focus === 'video') {
        if (action === Action.LEFT || action === Action.RIGHT) moveAnchor(action === Action.RIGHT ? 1 : -1);
        else if (action === Action.ENTER) {
          if (playing) stopPortion();
          else playPortion();
        } else if (action === Action.UP) {
          if (playing) stopPortion();
          focus = 'subs';
        }
      } else if (panelArea === 'points' && pointRows.length) {
        // The points, one under the other (Up / Down), each with Edit and Remove (Left / Right); Down from the last: the buttons.
        if (action === Action.UP) pointIndex = Math.max(0, pointIndex - 1);
        else if (action === Action.DOWN) {
          if (pointIndex < pointRows.length - 1) pointIndex += 1;
          else panelArea = 'buttons';
        } else if (action === Action.LEFT) pointButton = 0;
        else if (action === Action.RIGHT) pointButton = 1;
        else if (action === Action.ENTER) {
          if (pointButton) removePoint(pointIndex);
          else editPoint(pointIndex);
        }
      } else {
        // The buttons, in a row (Left / Right); Up: the points; Down: back to the bars.
        const list = panelButtons();
        if (action === Action.LEFT) buttonIndex = 0;
        else if (action === Action.RIGHT) buttonIndex = 1;
        else if (action === Action.UP && points.length) {
          panelArea = 'points';
          pointIndex = points.length - 1;
          pointButton = 0;
        } else if (action === Action.DOWN) focus = canAdd() ? 'video' : 'subs';
        else if (action === Action.ENTER && list[buttonIndex].enabled) list[buttonIndex].run();
      }
      render();
      return true;
    },
    /**
     * The Back key: the portion playing stops (back to the anchor); from the video bar back to the subtitles; from the subtitles to the
     * panel; from the panel the procedure ends (the points added stay; with enough good ones their timing is used).
     */
    back() {
      if (closed) return false;
      if (focus === 'video') {
        if (playing) stopPortion();
        else focus = 'subs';
      } else if (focus === 'subs') {
        focus = 'panel';
        panelArea = 'buttons';
      } else {
        close(canConclude() ? fit : null);
        return true;
      }
      render();
      return true;
    },
    /** Where the main progress bar shows the cursor, in ms: the portion playing, the anchor, or the line chosen. */
    mainCursor: () => (closed ? null : playing ? playhead : confirmed && anchor !== null ? anchor : toVideo(cues[index].start, timingNow())),
    destroy: () => close(null),
    isOpen: () => !closed,
  };
}
