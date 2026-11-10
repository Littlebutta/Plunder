/**
 * The player's hull health. Weather hazards (tentacle smacks, cursed ships'
 * cannon fire) knock it down; it patches itself up slowly once you're out of
 * trouble. At zero the ship is sunk (`onBattered`); the game brings her back
 * at the home island a few seconds later.
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
    if (amount <= 0 || this.hp <= 0) return;
    this.hp -= amount;
    this.sinceHit = 0;
    this.onDamage?.(amount);
    if (this.hp <= 0) {
      // sunk: the game brings the ship back at home and refills the hull
      this.hp = 0;
      this.onBattered?.();
    }
  }

  update(dt: number): void {
    this.sinceHit += dt;
    if (this.hp > 0 && this.sinceHit > this.repairDelay) this.hp = Math.min(this.max, this.hp + this.repairRate * dt);
  }
}
