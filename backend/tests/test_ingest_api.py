from app.api.ingest import get_ingest_service, get_sample_ingest_runner
from app.core.errors import AppError
from app.main import app
from app.services.ingest import DeleteMatchResult, IngestJobResult, IngestMatchAsset
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

    def start_sample_matches(
        self,
        *,
        platform: str,
        game_mode: str,
        max_matches: int,
        parse_profile: str,
        position_interval_seconds: int,
    ) -> IngestJobResult:
        assert platform == "steam"
        assert game_mode == "squad"
        assert max_matches == 12
        assert parse_profile == "zone_only"
        assert position_interval_seconds == 30
        return IngestJobResult(
            id="job_sample_matches",
            job_type="sample_matches",
            status="running",
            source_ref="samples:steam:squad:max=12:profile=zone_only:interval=30",
            total_count=0,
            success_count=0,
            skipped_count=0,
            failed_count=0,
            retry_count=0,
            started_at="2026-06-05T00:00:00+00:00",
            finished_at=None,
            error_code=None,
            error_message=None,
            warnings=[],
        )

    def download_match_telemetry(self, match_id: str) -> IngestJobResult:
        assert match_id == "match-1"
        return _job(job_id="job_telemetry")

    def parse_match_telemetry(self, match_id: str) -> IngestJobResult:
        assert match_id == "match-1"
        return _job(job_id="job_parse")

    def get_job(self, job_id: str) -> IngestJobResult:
        if job_id == "job_missing":
            raise AppError(
                code="INGEST_JOB_NOT_FOUND",
                message="ingest job 'job_missing' was not found",
                status_code=404,
                details={"job_id": job_id},
            )
        assert job_id == "job_tournament"
        return _job(job_id=job_id)

    def retry_job(self, job_id: str) -> IngestJobResult:
        assert job_id == "job_tournament"
        return _job(job_id="job_retry", retry_count=1)

    def cancel_job(self, job_id: str) -> IngestJobResult:
        assert job_id == "job_sample_matches"
        return IngestJobResult(
            id=job_id,
            job_type="sample_matches",
            status="cancelled",
            source_ref="samples:steam:squad:max=12:profile=zone_only:interval=30",
            total_count=12,
            success_count=2,
            skipped_count=1,
            failed_count=0,
            retry_count=0,
            started_at="2026-06-05T00:00:00+00:00",
            finished_at="2026-06-05T00:02:00+00:00",
            error_code=None,
            error_message=None,
            warnings=[],
        )

    def list_matches(self, *, limit: int) -> list[IngestMatchAsset]:
        assert limit == 25
        return [
            IngestMatchAsset(
                match_id="match-1",
                map_name="Erangel",
                shard_id="steam",
                game_mode="squad",
                match_type="official",
                created_at="2026-06-05T00:00:00+00:00",
                duration=1800,
                ingest_status="completed",
                telemetry_url="https://example.test/telemetry.json",
                telemetry_cache_path="/tmp/match-1.json",
                telemetry_parse_status="completed",
                telemetry_downloaded_at="2026-06-05T00:01:00+00:00",
                circle_phase_count=6,
                position_sample_count=120,
                life_event_count=8,
            )
        ]

    def delete_match(self, match_id: str) -> DeleteMatchResult:
        assert match_id == "match-1"
        return DeleteMatchResult(
            match_id="match-1",
            deleted=True,
            telemetry_cache_deleted=True,
            circle_phase_count=6,
            position_sample_count=120,
            life_event_count=8,
        )


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


def test_ingest_squad_samples_api_returns_job_status() -> None:
    app.dependency_overrides[get_ingest_service] = lambda: FakeIngestService()
    app.dependency_overrides[get_sample_ingest_runner] = lambda: (
        lambda _job_id, _platform, _game_mode, _max_matches, _parse_profile, _interval: None
    )
    client = TestClient(app)
    try:
        response = client.post(
            "/api/ingest/samples/squad?max_matches=12"
            "&parse_profile=zone_only&position_interval_seconds=30"
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == "job_sample_matches"
    assert body["job_type"] == "sample_matches"
    assert body["status"] == "running"
    assert body["source_ref"] == "samples:steam:squad:max=12:profile=zone_only:interval=30"


def test_cancel_job_api_returns_cancelled_job() -> None:
    app.dependency_overrides[get_ingest_service] = lambda: FakeIngestService()
    client = TestClient(app)
    try:
        response = client.post("/api/ingest/jobs/job_sample_matches/cancel")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == "job_sample_matches"
    assert body["status"] == "cancelled"


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


def test_get_missing_job_api_returns_not_found_error() -> None:
    app.dependency_overrides[get_ingest_service] = lambda: FakeIngestService()
    client = TestClient(app)
    try:
        response = client.get("/api/ingest/jobs/job_missing")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "INGEST_JOB_NOT_FOUND"


def test_parse_match_telemetry_api_returns_job_status() -> None:
    app.dependency_overrides[get_ingest_service] = lambda: FakeIngestService()
    client = TestClient(app)
    try:
        response = client.post("/api/ingest/matches/match-1/telemetry/parse")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["id"] == "job_parse"


def test_list_matches_api_returns_assets() -> None:
    app.dependency_overrides[get_ingest_service] = lambda: FakeIngestService()
    client = TestClient(app)
    try:
        response = client.get("/api/ingest/matches?limit=25")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["matches"][0]["match_id"] == "match-1"
    assert body["matches"][0]["circle_phase_count"] == 6
    assert "api_key" not in body["matches"][0]


def test_delete_match_api_returns_deleted_counts() -> None:
    app.dependency_overrides[get_ingest_service] = lambda: FakeIngestService()
    client = TestClient(app)
    try:
        response = client.delete("/api/ingest/matches/match-1")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["deleted"] is True
    assert body["telemetry_cache_deleted"] is True
    assert body["position_sample_count"] == 120
