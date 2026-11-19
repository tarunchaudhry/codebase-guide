export interface Post { id: string; title: string }

const posts: Post[] = [{ id: '1', title: 'Hello' }];

export async function listPosts(): Promise<Post[]> {
  return posts;
}

export async function getPost(id: string): Promise<Post | undefined> {
  return posts.find((p) => p.id === id);
}

export async function deletePost(id: string): Promise<void> {
  posts.splice(posts.findIndex((p) => p.id === id), 1);
}
