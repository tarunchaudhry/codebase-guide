'use client';

import { createTodo } from '@/app/actions';
import { formatCount } from '@/lib/format';
import { Button } from './Button';

export function TodoForm() {
  return (
    <form action={createTodo}>
      <input name="title" />
      <Button label={formatCount(1)} />
    </form>
  );
}
