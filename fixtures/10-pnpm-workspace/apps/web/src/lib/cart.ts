import { total } from './totals';

export class Cart {
  items: number[] = [];

  add(cents: number): number {
    this.items.push(cents);
    return this.total();
  }

  total(): number {
    return total(this);
  }
}
