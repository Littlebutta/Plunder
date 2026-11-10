/**
 * No menu in the game scrolls. A card that would run off the screen is shrunk
 * (CSS zoom, which scales its layout and text together) until it fits, and
 * grows back when there is room. Fitted again whenever its contents change or
 * the window is resized.
 */
const fitted = new Set<() => void>();
let listening = false;

function watch(apply: () => void, el: HTMLElement): void {
  fitted.add(apply);
  new MutationObserver(() => apply()).observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  if (!listening) {
    listening = true;
    window.addEventListener('resize', () => fitted.forEach((f) => f()));
  }
  apply();
}

/**
 * Keep `card` within this share of the window's height (and width), however
 * much is in it.
 */
export function fitCard(card: HTMLElement, heightShare = 0.94, widthShare = 0.98): void {
  let busy = false;
  const apply = () => {
    if (busy || !card.isConnected || card.offsetParent === null) return;
    busy = true;
    card.style.zoom = '';
    const h = card.scrollHeight;
    const w = card.scrollWidth;
    const z = Math.min(1, (window.innerHeight * heightShare) / Math.max(1, h), (window.innerWidth * widthShare) / Math.max(1, w));
    card.style.zoom = z < 0.995 ? String(Math.max(0.45, z)) : '';
    busy = false;
  };
  const host = card.parentElement && card.parentElement !== document.body ? card.parentElement : card;
  watch(() => requestAnimationFrame(apply), host);
  card.addEventListener('transitionend', apply);
}

/**
 * For a full-screen page (the shipyard): shrink all of `root` until none of
 * the `panes` inside it overflow their boxes.
 */
export function fitPage(root: HTMLElement, panes: () => HTMLElement[]): void {
  let busy = false;
  const apply = () => {
    if (busy || root.hidden || !root.isConnected) return;
    busy = true;
    let z = 1;
    root.style.zoom = '';
    for (let i = 0; i < 6; i++) {
      let worst = 1;
      for (const p of panes()) if (p.clientHeight > 0) worst = Math.max(worst, p.scrollHeight / p.clientHeight);
      if (worst <= 1.002) break;
      z = Math.max(0.45, z / Math.min(worst, 1.6));
      root.style.zoom = String(z);
    }
    busy = false;
  };
  watch(() => requestAnimationFrame(apply), root);
}
