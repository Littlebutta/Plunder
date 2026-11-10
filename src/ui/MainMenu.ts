export interface MenuActions {
  play(): void;
  shipyard(): void;
  settings(): void;
  newMap(): void;
}

/**
 * Title menu: options down the left, the live game scene (a raft sailing on
 * its own) fills the rest of the screen and can be orbited by dragging.
 */
export class MainMenu {
  private readonly root: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly yardBtn: HTMLButtonElement;

  constructor(parent: HTMLElement, actions: MenuActions) {
    this.root = document.createElement('div');
    this.root.className = 'menu';
    const isDesktop = navigator.userAgent.includes('Electron');
    this.root.innerHTML = `
      <div class="menu-side">
        <div class="menu-title">Plunder</div>
        <div class="menu-sub">Build a ship. Take the islands.</div>
        <button data-act="play">Set sail</button>
        <button data-act="shipyard">Shipyard <small>draw and launch your own ship</small></button>
        <button data-act="multi" disabled>Multiplayer <small>with Steam friends, later</small></button>
        <button data-act="newmap">New map <small>generate a fresh set of islands</small></button>
        <button data-act="settings">Settings <small>sound and music volume</small></button>
        ${isDesktop ? '<button data-act="quit">Quit</button>' : ''}
        <div class="menu-foot">Hold the middle mouse button and drag to look around</div>
      </div>`;
    parent.append(this.root);
    this.playBtn = this.root.querySelector('[data-act="play"]') as HTMLButtonElement;
    this.yardBtn = this.root.querySelector('[data-act="shipyard"]') as HTMLButtonElement;
    this.root.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn || btn.disabled) return;
      switch (btn.dataset.act) {
        case 'play':
          actions.play();
          break;
        case 'shipyard':
          actions.shipyard();
          break;
        case 'newmap':
          actions.newMap();
          break;
        case 'settings':
          actions.settings();
          break;
        case 'quit':
          window.close();
          break;
      }
      btn.blur();
    });
  }

  /** @param resumable true once a voyage is under way, so the button reads "Resume" */
  show(resumable: boolean, atDock = true): void {
    this.playBtn.textContent = resumable ? 'Resume voyage' : 'Set sail';
    this.yardBtn.disabled = !atDock;
    this.yardBtn.innerHTML = `Shipyard <small>${atDock ? 'draw and launch your own ship' : 'only at your home dock: sail her alongside'}</small>`;
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }
}
