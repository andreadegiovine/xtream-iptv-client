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

const COLUMNS = 10;

/**
 * Focus of the profile form: the avatars in a grid (COLUMNS a row), then the rows one under the other, then Cancel / Save on one line.
 * Down from the last avatar row goes to the first row, Up from it to the avatar `back()` (the chosen one); Down from the last row to Save.
 */
export function profileFormModel({ avatars, rows, back }) {
  const lines = Math.ceil(avatars / COLUMNS);
  const first = avatars;
  const cancel = avatars + rows;
  const total = cancel + 2;
  const move = (index) => ({ type: 'move', index });
  const exit = (dir) => ({ type: 'exit', dir });
  return {
    getCount: () => total,
    navigate(dir, i) {
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
 * Resolves with { name, avatar, kids, admin, pin } (`pin`: undefined unchanged, '' removed, the new one) or null when cancelled.
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
      const status = h('div', { class: 'status', role: 'status' });
      const cancelBtn = createButton({ label: t('setup.cancel') });
      const saveBtn = createButton({ label: t('profiles.save'), variant: 'primary' });
      // The rows under the avatars, in focus order.
      const rows = [{ el: name.el, run: () => name.focus() }];
      if (roles && kidsAllowed) rows.push({ el: kids.el, run: () => { kids.set(!kids.get()); if (kids.get()) admin.set(false); } });
      if (roles) rows.push({ el: admin.el, run: () => { admin.set(!admin.get()); if (admin.get()) kids.set(false); } });
      rows.push({ el: pin.el, run: () => pin.focus() });
      if (removePin) rows.push({ el: removePin.el, run: () => removePin.set(!removePin.get()) });
      const cancelIndex = () => AVATARS.length + rows.length;
      const nodes = avatarNodes.concat(rows.map((r) => r.el), [cancelBtn, saveBtn]);

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
        close({ name: typedName, avatar, kids: roles ? kids.get() : Boolean(profile && profile.kids), admin: roles ? admin.get() : Boolean(profile && profile.admin), pin: nextPin });
      }

      const list = h('div', { class: 'list profile-form-rows' }, rows.filter((r) => r.el !== name.el && r.el !== pin.el).map((r) => r.el));
      body.appendChild(createHeading({ text: title }));
      body.appendChild(h('div', { class: 'profile-avatars' }, avatarNodes));
      body.appendChild(h('div', { class: 'form' }, name.root, list, pin.root, removePin ? h('div', { class: 'list' }, removePin.el) : null, status, h('div', { class: 'dialog-actions' }, cancelBtn, saveBtn)));

      ctx.focus.register(new FocusZone({
        id: zoneId,
        nodes: () => nodes,
        model: profileFormModel({ avatars: AVATARS.length, rows: rows.length, back: () => Math.max(0, AVATARS.indexOf(avatar)) }),
        onFocus: (i) => {
          nodes[i].classList.add('focused');
          ensureVisible(nodes[i], { first: i < COLUMNS });
        },
        onBlur: (i) => nodes[i] && nodes[i].classList.remove('focused'),
        onActivate: (i) => {
          if (i < AVATARS.length) pick(i);
          else if (i < cancelIndex()) rows[i - AVATARS.length].run();
          else if (i === cancelIndex()) close(null);
          else save();
        },
      }));
      ctx.focus.focus(zoneId, profile ? AVATARS.length : Math.max(0, AVATARS.indexOf(avatar)));
      return () => ctx.focus.unregister(zoneId);
    },
  });
}
