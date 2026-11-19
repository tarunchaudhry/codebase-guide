from fastapi import FastAPI

from .routers import items, reports, users

app = FastAPI()
app.include_router(users.router, prefix="/api")
app.include_router(items.router, prefix="/api")
app.include_router(reports.router, prefix="/api")


@app.get("/api/health")
def health():
    return {"ok": True}
