import type { Captain } from '../world/Captains';
import { drawPortrait, portraitElement } from './Portrait';

interface Line {
  captain: Captain;
  colour: string;
  name: string;
  text: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Captain chatter, the way an old space shooter does it: a pixel portrait
 * slides in, its mouth flaps while the line types out, then it slides away.
 * Players' chat messages and the AI captains' taunts both come through here.
 * Online, Enter opens a box to type in.
 */
export class Chat {
  private readonly root: HTMLElement;
  private readonly who: HTMLElement;
  private readonly said: HTMLElement;
  private readonly log: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly queue: Line[] = [];
  private current: Line | null = null;
  private shown = 0;
  private hold = 0;
  private flap = 0;
  private mouthOpen = false;
  /** A message typed and sent (online). */
  onSend: (text: string) => void = () => {};
  /** Can the player type (online only)? */
  canType = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'chat';
    this.root.innerHTML = `
      <div class="chat-log" data-log></div>
      <div class="chat-card" data-card>
        <div class="chat-face" data-face></div>
        <div class="chat-body"><div class="chat-who" data-who></div><div class="chat-text" data-text></div></div>
      </div>
      <input class="chat-input" data-input maxlength="120" placeholder="Say something... (Enter to send, Esc to cancel)" hidden>`;
    parent.append(this.root);
    const q = <T extends HTMLElement>(s: string) => this.root.querySelector(s) as T;
    this.who = q('[data-who]');
    this.said = q('[data-text]');
    this.log = q('[data-log]');
    this.input = q('[data-input]');
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = this.input.value.trim().slice(0, 120);
        this.input.value = '';
        this.closeInput();
        if (text) this.onSend(text);
      } else if (e.key === 'Escape') this.closeInput();
    });
    this.input.addEventListener('blur', () => this.closeInput());
  }

  get typing(): boolean {
    return !this.input.hidden;
  }

  openInput(): void {
    if (!this.canType) return;
    this.input.hidden = false;
    this.root.classList.add('typing');
    this.input.focus();
  }

  private closeInput(): void {
    if (this.input.hidden) return;
    this.input.hidden = true;
    this.root.classList.remove('typing');
    (document.getElementById('game') as HTMLElement | null)?.focus();
  }

  /** A captain says something. Lines wait their turn; a long queue drops the oldest. */
  say(captain: Captain, colour: string, name: string, text: string): void {
    this.queue.push({ captain, colour, name, text: text.slice(0, 160) });
    if (this.queue.length > 4) this.queue.shift();
  }

  update(dt: number): void {
    if (!this.current) {
      const next = this.queue.shift();
      if (!next) return;
      this.show(next);
    }
    const line = this.current!;
    if (this.shown < line.text.length) {
      // type the line out, quicker when others are waiting
      this.shown = Math.min(line.text.length, this.shown + dt * (this.queue.length ? 70 : 42));
      this.said.textContent = line.text.slice(0, Math.floor(this.shown));
      this.flap -= dt;
      if (this.flap <= 0) {
        this.flap = 0.09 + Math.random() * 0.06;
        // the mouth shuts on spaces and stops, which makes it read as speech
        const ch = line.text[Math.floor(this.shown)] ?? ' ';
        this.setMouth(/[a-z0-9]/i.test(ch) ? !this.mouthOpen : false);
      }
      if (this.shown >= line.text.length) {
        this.setMouth(false);
        this.hold = Math.max(2.2, Math.min(5, line.text.length * 0.05)) * (this.queue.length ? 0.5 : 1);
      }
      return;
    }
    this.hold -= dt;
    if (this.hold <= 0) {
      this.root.classList.remove('show');
      this.addLog(line);
      this.current = null;
    }
  }

  private show(line: Line): void {
    this.current = line;
    this.shown = 0;
    this.mouthOpen = false;
    const holder = this.root.querySelector('[data-face]') as HTMLElement;
    holder.replaceChildren(portraitElement(line.captain, line.colour, 3));
    this.who.innerHTML = `<i style="background:${line.colour}"></i>${esc(line.name)}`;
    this.said.textContent = '';
    this.root.classList.add('show');
  }

  private setMouth(open: boolean): void {
    if (!this.current || open === this.mouthOpen) return;
    this.mouthOpen = open;
    const el = this.root.querySelector('[data-face] canvas') as HTMLCanvasElement | null;
    if (el) drawPortrait(el, this.current.captain, this.current.colour, open);
  }

  /** The last few lines stay up a while in small print. */
  private addLog(line: Line): void {
    const row = document.createElement('div');
    row.innerHTML = `<b style="color:${line.colour}">${esc(line.name)}</b> ${esc(line.text)}`;
    this.log.append(row);
    while (this.log.childElementCount > 4) this.log.firstElementChild!.remove();
    setTimeout(() => row.classList.add('old'), 12000);
  }
}
