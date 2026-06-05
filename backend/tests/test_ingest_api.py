from app.api.ingest import get_ingest_service
from app.main import app
from app.services.ingest import IngestJobResult
from fastapi.testclient import TestClient


def _job(job_id: str = "job_test", retry_count: int = 0) -> IngestJobResult:
    return IngestJobResult(
        id=job_id,
        job_type="tournament_matches",
        status="completed",
        source_ref="tournament-1",
        total_count=2,
        success_count=1,
        skipped_count=1,
        failed_count=0,
        retry_count=retry_count,
        started_at="2026-06-05T00:00:00+00:00",
        finished_at="2026-06-05T00:01:00+00:00",
        error_code=None,
        error_message=None,
        warnings=["match 'match-2' has no telemetry URL"],
    )


class FakeIngestService:
    def ingest_tournaments(self) -> IngestJobResult:
        return _job(job_id="job_tournaments")

    def ingest_tournament(self, tournament_id: str) -> IngestJobResult:
        assert tournament_id == "tournament-1"
        return _job(job_id="job_tournament")

    def download_match_telemetry(self, match_id: str) -> IngestJobResult:
        assert match_id == "match-1"
        return _job(job_id="job_telemetry")

    def get_job(self, job_id: str) -> IngestJobResult:
        assert job_id == "job_tournament"
        return _job(job_id=job_id)

    def retry_job(self, job_id: str) -> IngestJobResult:
        assert job_id == "job_tournament"
        return _job(job_id="job_retry", retry_count=1)


def test_ingest_tournament_api_returns_job_status() -> None:
    app.dependency_overrides[get_ingest_service] = lambda: FakeIngestService()
    client = TestClient(app)
    try:
        response = client.post("/api/ingest/tournaments/tournament-1")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == "job_tournament"
    assert body["status"] == "completed"
    assert body["warnings"] == ["match 'match-2' has no telemetry URL"]
    assert "api_key" not in body


def test_retry_job_api_returns_new_job() -> None:
    app.dependency_overrides[get_ingest_service] = lambda: FakeIngestService()
    client = TestClient(app)
    try:
        response = client.post("/api/ingest/jobs/job_tournament/retry")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == "job_retry"
    assert body["retry_count"] == 1
