import { TodoForm } from '@/components/TodoForm';
import { listTodos, clearTodos } from '@/lib/db';
import { formatCount } from '@/lib/format';

export default async function TodosPage() {
  const todos = await listTodos();

  async function deleteAll() {
    'use server';
    await clearTodos();
  }

  return (
    <div>
      <p>{formatCount(todos.length)}</p>
      <TodoForm />
      <form action={deleteAll}>
        <button>Clear</button>
      </form>
    </div>
  );
}
