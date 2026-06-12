from app.main import app
from fastapi.testclient import TestClient


def test_list_maps_api_returns_configured_maps() -> None:
    client = TestClient(app)

    response = client.get("/api/config/maps")

    assert response.status_code == 200
    body = response.json()
    map_ids = [map_config["map_id"] for map_config in body["maps"]]

    assert map_ids == ["erangel", "karakin", "miramar"]
    assert body["maps"][1]["display_name"] == "Karakin"
    assert body["maps"][1]["telemetry_names"] == ["Summerland_Main"]
    assert body["maps"][1]["assets"]["high"] == "Assets/Maps/Karakin_Main_High_Res.png"
    assert body["maps"][2]["display_name"] == "Miramar"
    assert body["maps"][2]["assets"]["high"] == "Assets/Maps/Miramar_Main_High_Res.png"


def test_zone_phases_api_returns_mvp_config() -> None:
    client = TestClient(app)

    response = client.get("/api/config/zone-phases", params={"map_id": "erangel"})

    assert response.status_code == 200
    body = response.json()
    assert body["final_phase"] == 8
    assert body["supported_prediction_phases"] == [1, 2, 3, 4, 5, 6, 7]


def test_zone_phases_api_supports_miramar() -> None:
    client = TestClient(app)

    response = client.get("/api/config/zone-phases", params={"map_id": "miramar"})

    assert response.status_code == 200
    body = response.json()
    assert body["map_id"] == "miramar"
    assert body["final_phase"] == 8
    assert body["phases"][-1]["is_final_candidate"] is True


def test_zone_phases_api_supports_karakin() -> None:
    client = TestClient(app)

    response = client.get("/api/config/zone-phases", params={"map_id": "karakin"})

    assert response.status_code == 200
    body = response.json()
    assert body["map_id"] == "karakin"
    assert body["final_phase"] == 8
    assert body["phases"][0]["radius"] == 100000
    assert body["phases"][-1]["is_final_candidate"] is True


def test_unknown_map_uses_uniform_error_shape() -> None:
    client = TestClient(app)

    response = client.get("/api/config/zone-phases", params={"map_id": "missing"})

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "UNSUPPORTED_MAP"


def test_coordinate_convert_api_supports_world_to_pixel() -> None:
    client = TestClient(app)

    response = client.post(
        "/api/config/maps/erangel/coordinates/convert",
        json={
            "source": "world",
            "target": "pixel",
            "point": {"x": 408000, "y": 408000},
            "image_size": {"width": 1024, "height": 1024},
        },
    )

    assert response.status_code == 200
    assert response.json()["point"] == {"x": 512, "y": 512}


def test_llm_status_does_not_expose_secret() -> None:
    client = TestClient(app)

    response = client.get("/api/config/llm-status")

    assert response.status_code == 200
    assert "api_key" not in response.json()
