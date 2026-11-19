import { Cart } from './cart';

const cart = new Cart();
if (cart.add(5) !== 5) throw new Error('bad total');
