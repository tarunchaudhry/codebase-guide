import { formatPrice } from '../format';

if (formatPrice(100) !== '$1.00') throw new Error('bad format');
