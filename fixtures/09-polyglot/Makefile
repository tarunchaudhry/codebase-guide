install:
	cd frontend && npm install && cd ../backend && pip install -e .

dev:
	cd backend && uvicorn app.main:app --reload

test:
	cd backend && pytest

.PHONY: install dev test
