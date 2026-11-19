import axios from 'axios';

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

export const api = axios.create({ baseURL: process.env.NEXT_PUBLIC_API_URL });

export async function getHealth() {
  return fetch('/api/health');
}

export async function getUser(id: string) {
  return fetch(`/api/users/${id}`);
}

export async function createUser(email: string) {
  return api.post('/api/users/', { email });
}

export async function deleteItem(itemId: number) {
  return fetch(`${API_BASE}/api/items/${itemId}`, { method: 'DELETE' });
}

export async function listReports() {
  return fetch('/api/reports');
}

export async function githubProfile(name: string) {
  return fetch(`https://api.github.com/users/${name}`);
}

export async function callAnything(url: string) {
  return fetch(url);
}

export async function getSession() {
  return fetch('/api/session');
}
