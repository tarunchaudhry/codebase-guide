import { getPost, type Post } from '../../lib/posts';

export async function getServerSideProps({ params }: { params: { id: string } }) {
  return { props: { post: await getPost(params.id) } };
}

export default function PostPage({ post }: { post: Post }) {
  return <article>{post.title}</article>;
}
