from fastapi import APIRouter

router = APIRouter(prefix="/reports")


@router.get("/{report_id}/download")
def download_report(report_id: int):
    return b""
