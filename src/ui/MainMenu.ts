export interface MenuActions {
  play(): void;
  toggleSound(): boolean; // returns true if sound is now on
}

/**
 * Title menu: options down the left, the live game scene (a raft sailing on
 * its own) fills the rest of the screen and can be orbited by dragging.
 */
export class MainMenu {
  private readonly root: HTMLElement;
  private readonly playBtn: HTMLButtonElement;

  constructor(parent: HTMLElement, actions: MenuActions) {
    this.root = document.createElement('div');
    this.root.className = 'menu';
    const isDesktop = navigator.userAgent.includes('Electron');
    this.root.innerHTML = `
      <div class="menu-side">
        <div class="menu-title">Plunder</div>
        <div class="menu-sub">Build a ship. Take the islands.</div>
        <button data-act="play">Set sail</button>
        <button data-act="shipyard" disabled>Shipyard <small>coming next</small></button>
        <button data-act="multi" disabled>Multiplayer <small>with Steam friends, later</small></button>
        <button data-act="sound">Sound: on</button>
        ${isDesktop ? '<button data-act="quit">Quit</button>' : ''}
        <div class="menu-foot">Drag to look around</div>
      </div>`;
    parent.append(this.root);
    this.playBtn = this.root.querySelector('[data-act="play"]') as HTMLButtonElement;
    this.root.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn || btn.disabled) return;
      switch (btn.dataset.act) {
        case 'play':
          actions.play();
          break;
        case 'sound':
          btn.textContent = `Sound: ${actions.toggleSound() ? 'on' : 'off'}`;
          break;
        case 'quit':
          window.close();
          break;
      }
      btn.blur();
    });
  }

  /** @param resumable true once a voyage is under way, so the button reads "Resume" */
  show(resumable: boolean): void {
    this.playBtn.textContent = resumable ? 'Resume voyage' : 'Set sail';
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }
}
