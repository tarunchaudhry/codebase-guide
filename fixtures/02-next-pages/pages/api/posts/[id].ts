import type { NextApiRequest, NextApiResponse } from 'next';
import { deletePost, getPost } from '../../../lib/posts';

export default async function postHandler(req: NextApiRequest, res: NextApiResponse) {
  switch (req.method) {
    case 'GET':
      return res.json(await getPost(String(req.query.id)));
    case 'DELETE':
      await deletePost(String(req.query.id));
      return res.status(204).end();
    default:
      return res.status(405).end();
  }
}
