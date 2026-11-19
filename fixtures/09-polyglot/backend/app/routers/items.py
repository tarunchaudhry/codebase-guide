from fastapi import APIRouter

router = APIRouter(prefix="/items")


@router.delete("/{item_id}")
def delete_item(item_id: int):
    return None
