import { h, cx } from '../dom.js';
import { t } from '../../i18n/index.js';
import { createAvatar } from '../atoms/avatar.js';
import { createButton } from '../atoms/button.js';
import { createHeading } from '../atoms/heading.js';
import { createField } from '../atoms/field.js';
import { createListRow } from '../atoms/listRow.js';
import { createToggle, setToggle } from '../atoms/toggle.js';
import { FocusZone } from '../focus/FocusManager.js';
import { Dir } from '../focus/models.js';
import { ensureVisible } from '../scroll.js';
import { AVATARS } from '../../services/profiles.js';
import { AGES, cleanLimits, normalizeTime } from '../../services/kidsLimits.js';
import { icon } from '../icons.js';
import { ageLabel } from '../ageLabel.js';

const COLUMNS = 10;

/**
 * Focus of the profile form: the avatars in a grid (COLUMNS a row), then the rows one under the other, then Cancel / Save on one line.
 * Down from the last avatar row goes to the first row, Up from it to the avatar `back()` (the chosen one); Down from the last row to Save.
 */
export function profileFormModel({ avatars, rows, back }) {
  const lines = Math.ceil(avatars / COLUMNS);
  const first = avatars;
  const rowCount = typeof rows === 'function' ? rows : () => rows; // rows can come and go (the limits of a kids profile)
  const move = (index) => ({ type: 'move', index });
  const exit = (dir) => ({ type: 'exit', dir });
  return {
    getCount: () => avatars + rowCount() + 2,
    navigate(dir, i) {
      const cancel = avatars + rowCount();
      const total = cancel + 2;
      if (i < avatars) {
        const col = i % COLUMNS;
        const line = Math.floor(i / COLUMNS);
        if (dir === Dir.LEFT) return col > 0 ? move(i - 1) : exit(dir);
        if (dir === Dir.RIGHT) return col < COLUMNS - 1 && i + 1 < avatars ? move(i + 1) : exit(dir);
        if (dir === Dir.UP) return line > 0 ? move(i - COLUMNS) : exit(dir);
        return line < lines - 1 ? move(Math.min(i + COLUMNS, avatars - 1)) : move(first);
      }
      if (i < cancel) {
        if (dir === Dir.UP) return i > first ? move(i - 1) : move(back());
        if (dir === Dir.DOWN) return move(i + 1 < cancel ? i + 1 : cancel + 1);
        return exit(dir);
      }
      if (dir === Dir.LEFT) return i > cancel ? move(i - 1) : exit(dir);
      if (dir === Dir.RIGHT) return i < total - 1 ? move(i + 1) : exit(dir);
      if (dir === Dir.UP) return move(cancel - 1);
      return exit(dir);
    },
  };
}

/** A toggle row of the form. */
function toggleRow(label, on) {
  const value = createToggle();
  setToggle(value, on);
  const row = createListRow({ label, valueEl: value });
  return { el: row.el, value, get: () => value.classList.contains('on'), set: (next) => setToggle(value, next) };
}


/**
 * Adding or editing a profile, in a dialog: avatar, name, kids, admin (`roles`: only an admin sets them), access PIN (4 digits, optional).
 * A kids profile also has its limits (an admin sets them): no watching before / after a time, daily minutes, minimum and maximum age rating
 * (drop-downs).
 * Resolves with { name, avatar, kids, admin, pin, limits } (`pin`: undefined unchanged, '' removed, the new one) or null when cancelled.
 * `profile`: the one edited (null: a new one); `title`.
 */
export function openProfileForm(ctx, { profile = null, title, roles = true, kidsAllowed = true }) {
  return ctx.dialogs.panel({
    className: 'profile-dialog',
    cancelValue: null,
    mount({ body, zoneId, close }) {
      let avatar = profile ? profile.avatar : AVATARS[Math.floor(Math.random() * AVATARS.length)];
      const avatarNodes = AVATARS.map((id) => h('span', { class: cx('profile-avatar-choice', id === avatar && 'selected') }, createAvatar(id)));
      const name = createField({ label: t('profiles.name'), onSubmit: () => ctx.focus.focus(zoneId, AVATARS.length + 1), onLeave: () => undefined, clearable: false });
      if (profile) name.setValue(profile.name);
      const kids = toggleRow(t('profiles.kidsToggle'), Boolean(profile && profile.kids));
      const admin = toggleRow(t('profiles.adminToggle'), Boolean(profile && profile.admin));
      const hasPin = Boolean(profile && profile.pin);
      const pin = createField({ label: t('profiles.pin'), type: 'password', inputmode: 'numeric', placeholder: hasPin ? t('profiles.pinKeep') : t('profiles.pinNone'), onSubmit: () => ctx.focus.focus(zoneId, cancelIndex() + 1), onLeave: () => undefined, clearable: false });
      const removePin = hasPin ? toggleRow(t('profiles.pinRemove'), false) : null;
      // The limits of a kids profile, shown while "Kids profile" is on.
      const limits = cleanLimits(profile && profile.limits);
      const limitField = (label, value, extra = {}) => {
        // Done: the next row of the form.
        const field = createField({ label, placeholder: t('profiles.optional'), onSubmit: () => ctx.focus.focus(zoneId, AVATARS.length + rows().findIndex((r) => r.el === field.el) + 1), onLeave: () => undefined, clearable: false, ...extra });
        field.setValue(value);
        return field;
      };
      const before = limitField(t('profiles.lockBefore'), limits.before, { inputmode: 'numeric', placeholder: t('profiles.timeHint') });
      const after = limitField(t('profiles.lockAfter'), limits.after, { inputmode: 'numeric', placeholder: t('profiles.timeHint') });
      const minutes = limitField(t('profiles.dailyMinutes'), limits.minutes ? String(limits.minutes) : '', { inputmode: 'numeric' });
      // The rating range: two drop-downs (a list over the form), each optional.
      const ageSelect = (label, start) => {
        const select = { age: start };
        const valueEl = h('span', { class: 'value select-value' }, h('span', { text: ageLabel(start) }), icon('chevron', 'select-chevron'));
        select.row = createListRow({ label, valueEl });
        select.open = async () => {
          const value = await ctx.dialogs.choose({ title: label, nested: true, selected: select.age === null ? 'none' : select.age, options: AGES.map((age) => ({ label: ageLabel(age), value: age === null ? 'none' : age })) });
          if (value === null) return; // closed without a choice
          select.age = value === 'none' ? null : value;
          valueEl.firstChild.textContent = ageLabel(select.age);
        };
        return select;
      };
      const minSelect = ageSelect(t('profiles.minRating'), limits.minAge);
      const maxSelect = ageSelect(t('profiles.maxRating'), limits.maxAge);
      const limitsEl = h('div', { class: 'profile-limits' }, before.root, after.root, minutes.root, h('div', { class: 'list' }, minSelect.row.el, maxSelect.row.el));
      const kidsOn = () => roles && kidsAllowed && kids.get();
      const showLimits = () => { limitsEl.style.display = kidsOn() ? '' : 'none'; };
      const status = h('div', { class: 'status', role: 'status' });
      const cancelBtn = createButton({ label: t('setup.cancel') });
      const saveBtn = createButton({ label: t('profiles.save'), variant: 'primary' });
      // The rows under the avatars, in focus order.
      const allRows = [{ el: name.el, run: () => name.focus() }];
      if (roles && kidsAllowed) allRows.push({ el: kids.el, run: () => { kids.set(!kids.get()); if (kids.get()) admin.set(false); showLimits(); } });
      if (roles) allRows.push({ el: admin.el, run: () => { admin.set(!admin.get()); if (admin.get()) kids.set(false); showLimits(); } });
      [before, after, minutes].forEach((field) => allRows.push({ el: field.el, run: () => field.focus(), kidsOnly: true }));
      [minSelect, maxSelect].forEach((select) => allRows.push({ el: select.row.el, kidsOnly: true, run: () => select.open() }));
      allRows.push({ el: pin.el, run: () => pin.focus() });
      if (removePin) allRows.push({ el: removePin.el, run: () => removePin.set(!removePin.get()) });
      const rows = () => allRows.filter((r) => !r.kidsOnly || kidsOn());
      const cancelIndex = () => AVATARS.length + rows().length;
      const nodes = () => avatarNodes.concat(rows().map((r) => r.el), [cancelBtn, saveBtn]);

      function pick(i) {
        avatar = AVATARS[i];
        avatarNodes.forEach((node, n) => node.classList.toggle('selected', n === i));
      }
      function save() {
        const typedName = name.getValue().trim();
        const typedPin = pin.getValue().trim();
        if (!typedName) {
          status.textContent = t('profiles.nameNeeded');
          return;
        }
        if (typedPin && !/^\d{4}$/.test(typedPin)) {
          status.textContent = t('profiles.pinFormat');
          return;
        }
        const nextPin = removePin && removePin.get() ? '' : typedPin || undefined;
        let nextLimits = profile && profile.limits; // kept as they are by a form without the limits (the kids profile itself)
        if (kidsOn()) {
          const times = [before, after].map((field) => normalizeTime(field.getValue()));
          const typedMinutes = minutes.getValue().trim();
          if (times.some((time) => time === null)) {
            status.textContent = t('profiles.timeFormat');
            return;
          }
          if (typedMinutes && !/^\d{1,4}$/.test(typedMinutes)) {
            status.textContent = t('profiles.minutesFormat');
            return;
          }
          if (minSelect.age !== null && maxSelect.age !== null && minSelect.age > maxSelect.age) {
            status.textContent = t('profiles.rangeFormat');
            return;
          }
          nextLimits = { before: times[0], after: times[1], minutes: Number(typedMinutes) || 0, minAge: minSelect.age, maxAge: maxSelect.age };
        }
        close({ name: typedName, avatar, kids: roles ? kids.get() : Boolean(profile && profile.kids), admin: roles ? admin.get() : Boolean(profile && profile.admin), pin: nextPin, limits: nextLimits });
      }

      const list = h('div', { class: 'list profile-form-rows' }, [roles && kidsAllowed ? kids.el : null, roles ? admin.el : null].filter(Boolean));
      body.appendChild(createHeading({ text: title }));
      body.appendChild(h('div', { class: 'profile-avatars' }, avatarNodes));
      showLimits();
      body.appendChild(h('div', { class: 'form' }, name.root, list, limitsEl, pin.root, removePin ? h('div', { class: 'list' }, removePin.el) : null, status, h('div', { class: 'dialog-actions' }, cancelBtn, saveBtn)));

      ctx.focus.register(new FocusZone({
        id: zoneId,
        nodes,
        model: profileFormModel({ avatars: AVATARS.length, rows: () => rows().length, back: () => Math.max(0, AVATARS.indexOf(avatar)) }),
        onFocus: (i) => {
          const node = nodes()[i];
          node.classList.add('focused');
          ensureVisible(node, { first: i < COLUMNS });
        },
        onBlur: (i) => {
          const node = nodes()[i];
          if (node) node.classList.remove('focused');
        },
        onActivate: (i) => {
          if (i < AVATARS.length) pick(i);
          else if (i < cancelIndex()) rows()[i - AVATARS.length].run();
          else if (i === cancelIndex()) close(null);
          else save();
        },
      }));
      ctx.focus.focus(zoneId, profile ? AVATARS.length : Math.max(0, AVATARS.indexOf(avatar)));
      return () => ctx.focus.unregister(zoneId);
    },
  });
}
