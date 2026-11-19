import { listPosts, type Post } from '../../lib/posts';

export async function getServerSideProps() {
  return { props: { posts: await listPosts() } };
}

export default function Posts({ posts }: { posts: Post[] }) {
  return <ul>{posts.map((p) => <li key={p.id}>{p.title}</li>)}</ul>;
}
