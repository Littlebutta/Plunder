import { ECONOMY } from '../world/Resources';
import { ME } from '../world/Factions';
import { Hold, RESOURCE_IDS, Stock } from '../world/Resources';
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
    const held = territory.held(ME).length;
    const taking = territory.strongholds.find((s) => s.capture > 0 && territory.factions.hostile(ME, s.side));
    const key = [fleet, ...RESOURCE_IDS.map((id) => stores[id]), home.level, Math.ceil(home.hp), Math.ceil(home.capture), held, near?.name, offer?.label, can, dock, taking ? Math.ceil(taking.capture) : ''].join('|');
    if (key === this.last) return;
    this.last = key;

    const f = home.hp / home.maxHp;
    const losing = home.capture > 0 && home.side === ME;
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
  chartRows(territory: Territory, island: Island, near: Island | null, hold: Hold, fleet: number, designs: HullDesign[] = [], hq?: { price: Stock; summary: string; count: number; traders: number; traderCost: Stock }): string {
    const s = territory.at(island);
    const offer = territory.offer(island);
    const here = near === island;
    let html = '';
    if (s) {
      const f = territory.factions;
      const isHome = [...territory.homes.values()].includes(s);
      const whose = s.side === ME ? 'Your' : `${f.name(s.side)}'s`;
      const who = `${whose} ${isHome ? 'home' : 'outpost'}${s.side !== ME && f.allied(ME, s.side) ? ' (ally)' : ''}`;
      html += `<div class="row"><span>${who}: ${s.levelName}</span><b>${Math.ceil(s.hp)} / ${s.maxHp}</b></div>`;
      if (territory.factions.hostile(ME, s.side)) html += '<div class="chart-hint">Shoot it to ruins, then hold a ship close to take the island.</div>';
      else if (s.side !== ME) html += '<div class="chart-hint">Held by your ally.</div>';
      else html += `<div class="chart-hint">Sends ${ECONOMY.incomeBase + ECONOMY.incomeMetal + ECONOMY.incomePerLevel * s.level} units to your stores every ${STRONGHOLD.incomeEvery}s.</div>`;
    }
    if (offer) {
      const needsShip = offer.act === 'build';
      const can = (!needsShip || here) && canAfford(offer.cost, territory.stores, here ? hold : null);
      html += `<button data-island-act="${offer.act}" ${can ? '' : 'disabled'}>${offer.label} · ${costLabel(offer.cost)}</button>`;
      if (needsShip && !here) html += '<div class="chart-hint">Sail your flagship alongside to found an outpost.</div>';
      else if (!can) html += `<div class="chart-hint">Not enough in your stores.</div>`;
    }
    if (s && s === territory.home && s.side === ME) {
      html += `<button data-island-act="yard">Shipyard <small>design a ship, then build her here</small></button>`;
      if (hq) {
        const can = canAfford(hq.price, territory.stores, null);
        html += `<button data-island-act="upgrade" ${can ? '' : 'disabled'}>Buy a random upgrade <small>${costLabel(hq.price)}</small></button>`;
        html += `<div class="chart-hint">${hq.count ? `Upgrades (${hq.count}): ${hq.summary}` : 'No upgrades yet. Sink a ghost ship for a free one.'}</div>`;
        const trade = canAfford(hq.traderCost, territory.stores, null) && territory.held(ME).length > 1;
        html += `<button data-island-act="trader" ${trade ? '' : 'disabled'}>Build a trade ship <small>${costLabel(hq.traderCost)} · ${hq.traders} afloat</small></button>`;
        html += `<div class="chart-hint">${territory.held(ME).length > 1 ? 'Sails between your islands and brings back their goods. Unarmed, so guard her.' : 'Hold a second island to trade with.'}</div>`;
      }
      html += `<div class="chart-sub">Build an escort (${fleet} afloat)</div><div class="chart-ships">`;
      designs.forEach((d, n) => {
        const cost = escortCost(d);
        const can = canAfford(cost, territory.stores, null);
        html += `<button data-island-act="ship:${n}" ${can ? '' : 'disabled'}><b>${d.name}</b><small>${costLabel(cost)}</small></button>`;
      });
      html += '</div>';
    }
    return html;
  }

  /** @param leave online: the one way on from here, and what the button says */
  showDefeat(home: Stronghold, leave = ''): void {
    this.end.dataset.tone = 'defeat';
    this.end.innerHTML = `
      <div class="endgame-card">
        <div class="endgame-title">Home lost</div>
        <p>Your home at <b>${home.island.name}</b> has been taken. Your flag comes down.</p>
        ${leave ? `<button data-end="new">${leave}</button>` : '<button data-end="retry">Try again</button>\n        <button data-end="new">New map</button>'}
      </div>`;
    this.end.hidden = false;
  }

  showVictory(taken: Stronghold | null, leave = ''): void {
    this.end.dataset.tone = 'victory';
    this.end.innerHTML = `
      <div class="endgame-card">
        <div class="endgame-title">Victory!</div>
        <p>${taken ? `You have taken the raiders' home at <b>${taken.island.name}</b>. ` : 'Every rival captain has lost their home. '}These waters are yours.</p>
        <button data-end="on">Keep sailing</button>
        <button data-end="new">${leave || 'New map'}</button>
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
