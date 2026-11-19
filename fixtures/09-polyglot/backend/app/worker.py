import httpx
import requests

API = "http://localhost:8000"


def sync_users(emails):
    for email in emails:
        requests.post("http://localhost:8000/api/users/", json={"email": email})


def charge(amount):
    return httpx.post("https://payments.example.com/v1/charge", json={"amount": amount})


async def refresh(user_id):
    async with httpx.AsyncClient(base_url=API) as client:
        return await client.get(f"/api/users/{user_id}")
