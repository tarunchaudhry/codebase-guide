export default function PhotoModal({ params }: { params: { id: string } }) {
  return <dialog>{params.id}</dialog>;
}
