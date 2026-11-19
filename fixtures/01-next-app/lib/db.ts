const todos: string[] = [];

export async function listTodos() {
  return todos;
}

export async function insertTodo(title: string) {
  todos.push(title);
  return title;
}

export async function clearTodos() {
  todos.length = 0;
}
