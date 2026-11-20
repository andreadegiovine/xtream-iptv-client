import { h } from './dom.js';
import { t } from '../i18n/index.js';
import { icon } from './icons.js';
import { createAvatar } from './atoms/avatar.js';
import { FocusManager, FocusZone } from './focus/FocusManager.js';
import { ListModel } from './focus/models.js';
import { createDialogService } from './components/dialog.js';
import { InputService, Action } from '../core/input.js';
import { createPointer } from './pointer.js';
import { createStartBar, createStartBackdrop } from './startSkeleton.js';

const ZONE = 'profilePicker';

/** One profile on the start screen: its avatar, its name, a lock when it has a PIN, "Kids" for a kids profile. */
export function createProfileTile(profile) {
  return h(
    'div',
    { class: 'profile-tile', 'aria-label': profile.name },
    h('span', { class: 'profile-tile-avatar' }, createAvatar(profile.avatar)),
    h('span', { class: 'profile-tile-name', text: profile.name }),
    h('span', { class: 'profile-tile-tags' }, profile.pin ? icon('lock', 'profile-lock') : null, profile.kids ? h('span', { class: 'profile-kids', text: t('profiles.kids') }) : null),
  );
}

/**
 * "Who is watching?": shown at start when there is more than one profile, before the app is built (it has its own focus, keys, pointer
 * and PIN dialog, all gone once a profile is chosen). A profile with a PIN asks for it. Resolves with the chosen profile.
 */
export function pickProfile({ profiles, list, root = document.body }) {
  return new Promise((resolve) => {
    const focus = new FocusManager();
    const dialogs = createDialogService({ focus, root });
    const tiles = list.map((p) => createProfileTile(p));
    // As the first start: the bar (logo + placeholders) and the Home skeleton behind; the profiles centred over it, without a box.
    // The start's bar (startSkeleton.js) when it is there, otherwise its own.
    const startBar = document.querySelector('#topbar .start-bar');
    const bar = startBar ? null : createStartBar();
    const el = h(
      'section',
      { class: 'page setup first-run profile-picker' },
      createStartBackdrop(),
      h('div', { class: 'profile-choice' }, h('h1', { text: t('profiles.who') }), h('div', { class: 'profile-tiles' }, tiles)),
    );
    const barHost = document.getElementById('topbar') || root;
    const pageHost = document.getElementById('content') || root;
    const splash = pageHost.querySelector ? pageHost.querySelector('.boot-splash') : null;
    if (splash) splash.style.display = 'none'; // back once a profile is chosen, until the first page replaces it
    if (bar) barHost.appendChild(bar);
    pageHost.appendChild(el);
    const input = new InputService(document);
    let busy = false;

    function done(profile) {
      input.stop();
      pointer.destroy();
      focus.unregister(ZONE);
      el.remove();
      if (bar) bar.remove();
      if (splash) splash.style.display = '';
      resolve(profile);
    }

    async function choose(i) {
      if (busy) return;
      const profile = list[i];
      if (profile.pin) {
        busy = true;
        const pin = await dialogs.pin({ title: t('profiles.enterPin', { name: profile.name }), validate: async (value) => (profiles.verifyAccess(profile, value) ? '' : t('parental.wrong')) });
        busy = false;
        if (pin === null) return;
      }
      done(profile);
    }

    focus.register(new FocusZone({
      id: ZONE,
      nodes: () => tiles,
      model: new ListModel({ orientation: 'horizontal', getCount: () => tiles.length }),
      onFocus: (i) => tiles[i].classList.add('focused'),
      onBlur: (i) => tiles[i] && tiles[i].classList.remove('focused'),
      onActivate: (i) => choose(i),
    }));
    input.registerPlatformKeys();
    input.onAction((action) => {
      if (action === Action.BACK) {
        if (dialogs.isOpen()) dialogs.dismiss();
        return; // nowhere to go back to
      }
      focus.handle(action);
    });
    input.start();
    const pointer = createPointer({ focus, onBack: () => dialogs.isOpen() && dialogs.dismiss() });
    focus.focus(ZONE, 0);
  });
}
