import { costLabel } from '../world/Strongholds';
import { UPGRADES, UpgradeSet } from '../world/Upgrades';
import type { Stock } from '../world/Resources';
import { upgradeIcon } from './UpgradeIcons';
import { fitCard } from './fit';

/**
 * Your upgrades at a glance (I, or the button by the question mark): every
 * upgrade in the game with its icon, what it does, and how many of its steps
 * you hold. The ones you have stand out; the rest are greyed, so you can see
 * what is still to win from ghost ships or buy at the HQ.
 */
export class UpgradesPanel {
  private readonly root: HTMLElement;
  private readonly card: HTMLElement;
  private readonly button: HTMLButtonElement;
  private key = '';

  constructor(hudRoot: HTMLElement, overlayParent: HTMLElement) {
    this.button = document.createElement('button');
    this.button.className = 'hud-upbtn';
    this.button.title = 'Your upgrades (I)';
    this.button.setAttribute('aria-label', 'Show your upgrades');
    this.button.innerHTML = upgradeIcon('oak', 20) + '<span data-n>0</span>';
    this.button.addEventListener('click', (e) => {
      this.toggle();
      (e.currentTarget as HTMLElement).blur();
    });
    hudRoot.append(this.button);

    this.root = document.createElement('div');
    this.root.className = 'upgrades';
    this.root.hidden = true;
    this.card = document.createElement('div');
    this.card.className = 'upgrades-card';
    this.root.append(this.card);
    overlayParent.append(this.root);
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root || (e.target as HTMLElement).closest('[data-close]')) this.close();
    });
    fitCard(this.card);
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  toggle(): void {
    if (this.visible) this.close();
    else this.open();
  }

  open(): void {
    this.root.hidden = false;
    this.key = '';
  }

  close(): void {
    this.root.hidden = true;
  }

  /** Per frame: keep the button's count and (when open) the list up to date. */
  update(set: UpgradeSet, price: Stock, canBuy: boolean): void {
    const n = set.count;
    const label = this.button.querySelector('[data-n]') as HTMLElement;
    if (label.textContent !== String(n)) label.textContent = String(n);
    if (!this.visible) return;
    const key = `${[...set.taken].join()}|${costLabel(price)}|${canBuy}`;
    if (key === this.key) return;
    this.key = key;
    const rows = UPGRADES.map((u) => {
      const have = set.taken.get(u.id) ?? 0;
      const pips = Array.from({ length: u.max }, (_, i) => `<i class="${i < have ? 'on' : ''}"></i>`).join('');
      return `<div class="up-row ${have ? 'have' : ''} ${have >= u.max ? 'max' : ''}">
        <span class="up-badge">${upgradeIcon(u.id, 26)}</span>
        <span class="up-text"><b>${u.name}</b><small>${u.text}</small></span>
        <span class="up-pips" title="${have} of ${u.max}">${pips}</span>
      </div>`;
    }).join('');
    this.card.innerHTML = `
      <div class="up-head"><div class="up-title">Upgrades</div><div class="up-count">${n} taken</div><button data-close>Close</button></div>
      <div class="up-grid">${rows}</div>
      <div class="up-foot">Win one by sinking a <b>ghost ship</b>, or buy a random one at your <b>HQ</b> (your home island's panel on the chart, M) for <b>${costLabel(price)}</b>${canBuy ? '' : ' (your home is lost)'}. Each one can be taken a few times.</div>`;
  }
}
