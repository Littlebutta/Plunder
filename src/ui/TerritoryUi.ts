import { Hold, RESOURCE_IDS } from '../world/Resources';
import { canAfford, costLabel, STRONGHOLD, Stronghold, Territory } from '../world/Strongholds';
import { escortCost, HullDesign } from '../ship/HullDesign';
import type { Island } from '../world/Islands';

export interface EndActions {
  /** Start over on the same map. */
  retry(): void;
  /** Start over on a freshly generated map. */
  newMap(): void;
  /** Victory only: close the screen and sail on. */
  carryOn(): void;
}

/**
 * Territory HUD: the home island's health chip, the "press U to build" prompt
 * when a ship is alongside an island, and the defeat / victory screen.
 */
export class TerritoryUi {
  private readonly homeEl: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly end: HTMLElement;
  private last = '';

  constructor(root: HTMLElement, parent: HTMLElement, actions: EndActions) {
    this.homeEl = document.createElement('div');
    this.homeEl.className = 'hud-panel hud-home';
    this.prompt = document.createElement('div');
    this.prompt.className = 'hud-panel hud-build';
    this.prompt.hidden = true;
    root.append(this.homeEl, this.prompt);

    this.end = document.createElement('div');
    this.end.className = 'endgame';
    this.end.hidden = true;
    parent.append(this.end);
    this.end.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('button')?.dataset.end;
      if (act === 'retry') actions.retry();
      else if (act === 'new') actions.newMap();
      else if (act === 'on') actions.carryOn();
    });
  }

  update(territory: Territory, near: Island | null, hold: Hold, fleet: number, dock = false): void {
    const home = territory.home;
    const offer = near ? territory.offer(near) : null;
    const can = offer ? canAfford(offer.cost, territory.stores, hold) : false;
    const stores = territory.stores;
    const held = territory.strongholds.filter((s) => s.side === 'player').length;
    const taking = territory.strongholds.find((s) => s.side === 'npc' && s.capture > 0);
    const key = [fleet, ...RESOURCE_IDS.map((id) => stores[id]), home.level, Math.ceil(home.hp), Math.ceil(home.capture), held, near?.name, offer?.label, can, dock, taking ? Math.ceil(taking.capture) : ''].join('|');
    if (key === this.last) return;
    this.last = key;

    const f = home.hp / home.maxHp;
    const losing = home.capture > 0;
    this.homeEl.dataset.state = losing || home.ruined ? 'danger' : f < 0.999 ? 'hurt' : 'ok';
    this.homeEl.innerHTML = `
      <div class="home-title">Home · ${home.island.name}</div>
      <div class="home-row"><b>${home.levelName}</b><span>${held} island${held === 1 ? '' : 's'} held</span></div>
      <div class="home-bar"><i style="width:${Math.round(f * 100)}%"></i></div>
      ${fleet > 0 ? `<div class="home-fleet">Fleet: ${fleet} escort${fleet === 1 ? '' : 's'}</div>` : ''}
      ${losing ? `<div class="home-warn">Being taken! ${Math.max(0, Math.ceil(STRONGHOLD.captureTime - home.capture))}s</div>` : home.ruined ? '<div class="home-warn">In ruins</div>' : ''}`;

    if (taking) {
      this.prompt.hidden = false;
      this.prompt.innerHTML = `Taking <b>${taking.island.name}</b>… hold close for ${Math.max(0, Math.ceil(STRONGHOLD.captureTime - taking.capture))}s`;
    } else if (offer && near) {
      this.prompt.hidden = false;
      this.prompt.innerHTML = can
        ? `<kbd>U</kbd> ${offer.label} at <b>${near.name}</b> · ${costLabel(offer.cost)}`
        : `${offer.label} at <b>${near.name}</b> needs ${costLabel(offer.cost)}`;
      this.prompt.dataset.can = String(can);
      if (dock) this.prompt.innerHTML += ' · <kbd>Y</kbd> shipyard';
    } else if (dock) {
      this.prompt.hidden = false;
      this.prompt.dataset.can = 'true';
      this.prompt.innerHTML = '<kbd>Y</kbd> Shipyard: refit your ship or build escorts';
    } else this.prompt.hidden = true;
  }

  /** Extra rows for the chart's island panel. */
  chartRows(territory: Territory, island: Island, near: Island | null, hold: Hold, fleet: number, designs: HullDesign[] = []): string {
    const s = territory.at(island);
    const offer = territory.offer(island);
    const here = near === island;
    let html = '';
    if (s) {
      const who = s.side === 'player' ? (s.home ? 'Your home' : 'Your outpost') : s.home ? "Raiders' home" : 'Raider outpost';
      html += `<div class="row"><span>${who}: ${s.levelName}</span><b>${Math.ceil(s.hp)} / ${s.maxHp}</b></div>`;
      if (s.side === 'npc') html += '<div class="chart-hint">Shoot it to ruins, then hold a ship close to take the island.</div>';
      else html += `<div class="chart-hint">Sends ${1 + s.level} unit${s.level ? 's' : ''} to your stores every ${STRONGHOLD.incomeEvery}s.</div>`;
    }
    if (offer) {
      const needsShip = offer.act === 'build';
      const can = (!needsShip || here) && canAfford(offer.cost, territory.stores, here ? hold : null);
      html += `<button data-island-act="${offer.act}" ${can ? '' : 'disabled'}>${offer.label} · ${costLabel(offer.cost)}</button>`;
      if (needsShip && !here) html += '<div class="chart-hint">Sail your flagship alongside to found an outpost.</div>';
      else if (!can) html += `<div class="chart-hint">Not enough in your stores.</div>`;
    }
    if (s && s === territory.home && s.side === 'player') {
      const full = fleet >= STRONGHOLD.fleetMax;
      html += `<div class="chart-sub">Build an escort (${fleet} of ${STRONGHOLD.fleetMax})</div><div class="chart-ships">`;
      designs.forEach((d, n) => {
        const cost = escortCost(d);
        const can = !full && canAfford(cost, territory.stores, null);
        html += `<button data-island-act="ship:${n}" ${can ? '' : 'disabled'}><b>${d.name}</b><small>${costLabel(cost)}</small></button>`;
      });
      html += '</div>';
      if (full) html += `<div class="chart-hint">Your fleet is full (${STRONGHOLD.fleetMax} escorts).</div>`;
    }
    return html;
  }

  showDefeat(home: Stronghold): void {
    this.end.dataset.tone = 'defeat';
    this.end.innerHTML = `
      <div class="endgame-card">
        <div class="endgame-title">Home lost</div>
        <p>The raiders have taken <b>${home.island.name}</b>. Your flag comes down.</p>
        <button data-end="retry">Try again</button>
        <button data-end="new">New map</button>
      </div>`;
    this.end.hidden = false;
  }

  showVictory(taken: Stronghold): void {
    this.end.dataset.tone = 'victory';
    this.end.innerHTML = `
      <div class="endgame-card">
        <div class="endgame-title">Victory!</div>
        <p>You have taken the raiders' home at <b>${taken.island.name}</b>. These waters are yours.</p>
        <button data-end="on">Keep sailing</button>
        <button data-end="new">New map</button>
      </div>`;
    this.end.hidden = false;
  }

  hideEnd(): void {
    this.end.hidden = true;
  }

  get endVisible(): boolean {
    return !this.end.hidden;
  }
}
