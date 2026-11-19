const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

async function getPost(req, res) {
  res.json(await prisma.post.findUnique({ where: { id: Number(req.params.id) } }));
}

async function deletePost(req, res) {
  await prisma.post.delete({ where: { id: Number(req.params.id) } });
  res.status(204).end();
}

router.route('/:id').get(getPost).delete(deletePost);
router.get('/', async (_req, res) => {
  res.json(await prisma.post.findMany({ include: { comments: true } }));
});

module.exports = router;
