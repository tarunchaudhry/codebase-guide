'use client';

import useSWR from 'swr';

export default function UsersPage() {
  const { data } = useSWR('/api/users/me');
  return <pre>{JSON.stringify(data)}</pre>;
}
