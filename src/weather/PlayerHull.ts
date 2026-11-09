/**
 * The player's hull health. Weather hazards (tentacle smacks, cursed ships'
 * cannon fire) knock it down; it patches itself up slowly once you're out of
 * trouble. Hitting zero doesn't end the game yet: the ship is "battered",
 * loses its sail and limps on with some hull back, in keeping with the
 * forgiving arcade feel.
 */
export class PlayerHull {
  max = 100;
  hp = 100;
  /** Seconds since the last hit; repairs start after `repairDelay`. */
  private sinceHit = 99;
  repairDelay = 8;
  repairRate = 2.5;
  onBattered: (() => void) | null = null;
  onDamage: ((amount: number) => void) | null = null;

  get fraction(): number {
    return this.hp / this.max;
  }

  damage(amount: number): void {
    if (amount <= 0) return;
    this.hp -= amount;
    this.sinceHit = 0;
    this.onDamage?.(amount);
    if (this.hp <= 0) {
      this.hp = this.max * 0.4;
      this.onBattered?.();
    }
  }

  update(dt: number): void {
    this.sinceHit += dt;
    if (this.sinceHit > this.repairDelay) this.hp = Math.min(this.max, this.hp + this.repairRate * dt);
  }
}
