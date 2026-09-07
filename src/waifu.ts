/**
 * ':waifu' dance overlay: toggles a chromeless looping animated WebP that
 * tours the four screen corners (the tour itself is pure CSS; see .waifu in
 * style.css). The module owns only the element lifecycle so the reader keeps
 * every keystroke and click — the overlay never takes focus or intercepts
 * input, and it is hidden from the accessibility tree entirely.
 */

import waifuDance from './assets/waifu-dance.webp';

let waifu: HTMLDivElement | undefined;

/** Summon the waifu (true) or wave her goodbye (false). */
export function toggleWaifu(): boolean {
  if (waifu) {
    waifu.remove();
    waifu = undefined;
    return false;
  }
  const sprite = document.createElement('img');
  // ':waifu' is an explicit opt-in: summoning her is the informed choice, so
  // the dance plays regardless of the OS reduced-motion preference.
  sprite.src = waifuDance;
  sprite.alt = '';
  sprite.decoding = 'async';
  const overlay = document.createElement('div');
  overlay.className = 'waifu';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.append(sprite);
  document.body.append(overlay);
  waifu = overlay;
  return true;
}
