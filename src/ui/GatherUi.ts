import type { Gathering } from '../world/Gathering';
import type { Island } from '../world/Islands';
import { RESOURCE_IDS, RESOURCES } from '../world/Resources';

const TYPE_LABEL: Record<Island['type'], string> = {
  peak: 'Volcanic peak',
  ridge: 'Rocky ridge',
  mesa: 'Mesa',
  hills: 'Green hills',
  cay: 'Sandy cay',
  stacks: 'Sea stacks',
  wreck: 'Shipwreck island',
};

/** Stores readout (the player's one pool), "press E" prompt and the island panel shown while gathering. */
export class GatherUi {
  private readonly holdEl: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly panel: HTMLElement;
  private last = '';

  constructor(root: HTMLElement) {
    this.holdEl = document.createElement('div');
    this.holdEl.className = 'hud-panel hud-hold';
    this.prompt = document.createElement('div');
    this.prompt.className = 'hud-panel hud-prompt';
    this.prompt.hidden = true;
    this.panel = document.createElement('div');
    this.panel.className = 'hud-panel hud-island';
    this.panel.hidden = true;
    root.append(this.holdEl, this.prompt, this.panel);
  }

  update(g: Gathering, income = 0): void {
    const hold = g.hold;
    const sel = g.selected;
    const near = g.inRange;
    // Rebuild only when something visible changed.
    const key = [
      Math.round(income) + ':' + RESOURCE_IDS.map((id) => hold.stock[id]).join(','),
      sel ? sel.name + RESOURCE_IDS.map((id) => sel.stock[id]).join(',') + g.status + g.plundered : '',
      near ? near.name + RESOURCE_IDS.map((id) => near.stock[id]).join(',') + Math.ceil(g.bareFor(near)) : '',
    ].join('|');
    if (key !== this.last) {
      this.last = key;
      this.holdEl.innerHTML =
        `<span class="hold-title">Stores</span>` +
        RESOURCE_IDS.map((id) => `<span class="res"><i style="background:${RESOURCES[id].color}"></i>${RESOURCES[id].label} <b>${hold.stock[id]}</b></span>`).join('') +
        (income > 0 ? `<span class="income" title="Sent in by the islands you hold">+${Math.round(income)}/min</span>` : '');

      // alongside an island that is not yours: E sends the crew ashore to plunder it
      const why = near ? g.plunderProblem(near) : 'none';
      this.prompt.hidden = !near || !!g.plundering || (why !== '' && !g.canPlunder(near));
      if (near && !g.plundering) {
        const bare = g.bareFor(near);
        this.prompt.innerHTML = why
          ? `<b>${near.name}</b>: ${why}${bare > 0 ? ` It grows back in ${Math.ceil(bare)} s.` : ''}`
          : `<kbd>E</kbd> Plunder <b>${near.name}</b>`;
      }

      this.panel.hidden = !sel;
      if (sel) {
        const status = {
          idle: '',
          working: sel.port ? 'Loading at the pier…' : 'Crew gathering ashore…',
          'out-of-range': sel.port ? 'Out of range. Come alongside the pier.' : 'Out of range. Sail closer to the shore.',
          'hold-full': 'The hold is full.',
          empty: 'Nothing left here for now. It will regrow.',
          plundering: `Plundering! ${g.plundered} carried off. Stay alongside.`,
        }[g.status];
        const rows = RESOURCE_IDS.filter((id) => sel.capacity[id] > 0)
          .map((id) => {
            const pct = Math.round((sel.stock[id] / sel.capacity[id]) * 100);
            return `<div class="row"><span>${RESOURCES[id].label}</span><div class="bar"><i style="width:${pct}%;background:${RESOURCES[id].color}"></i></div><b>${sel.stock[id]}</b></div>`;
          })
          .join('');
        this.panel.innerHTML = `
          <div class="island-name">${sel.name}</div>
          <div class="island-type">${TYPE_LABEL[sel.type]}${sel.port ? ' · port' : ''}</div>
          ${rows}
          <div class="haul"><i data-haul></i></div>
          <div class="island-status ${g.status}">${status}</div>`;
      }
    }
    const haul = this.panel.querySelector('[data-haul]') as HTMLElement | null;
    if (haul) haul.style.width = `${Math.round(g.progress * 100)}%`;
  }
}
