'use server';

import { insertTodo } from '@/lib/db';

export async function createTodo(formData: FormData) {
  await insertTodo(String(formData.get('title')));
}
