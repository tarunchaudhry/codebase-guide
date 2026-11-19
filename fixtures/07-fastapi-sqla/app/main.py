import uuid

from fastapi import Depends, FastAPI

from .deps import verify_api_key
from .middleware import TimingMiddleware
from .routers import items, users

app = FastAPI(title="Inventory")
app.add_middleware(TimingMiddleware)


@app.middleware("http")
async def add_request_id(request, call_next):
    response = await call_next(request)
    response.headers["x-request-id"] = str(uuid.uuid4())
    return response


app.include_router(users.router, prefix="/api")
app.include_router(items.router, prefix="/api", dependencies=[Depends(verify_api_key)])


@app.get("/health")
def health():
    return {"ok": True}


def run():
    import uvicorn

    uvicorn.run(app)
