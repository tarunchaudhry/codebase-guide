import { listTodos, insertTodo } from '@/lib/db';

export async function GET() {
  return Response.json(await listTodos());
}

export async function POST(req: Request) {
  const body = await req.json();
  return Response.json(await insertTodo(body.title));
}
