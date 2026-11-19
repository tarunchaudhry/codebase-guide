import { Cart } from './cart';

export function total(cart: Cart): number {
  let sum = 0;
  for (const c of cart.items) {
    if (c > 0) sum += c;
  }
  return sum;
}

export function emptyCart(): Cart {
  return new Cart();
}
