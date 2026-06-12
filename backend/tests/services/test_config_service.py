from pathlib import Path

from app.services.config_service import ConfigService


def test_list_maps_reads_yaml_config() -> None:
    service = ConfigService(Path("config"))

    maps = service.list_maps()

    map_ids = [map_config["map_id"] for map_config in maps]

    assert map_ids == ["erangel", "karakin", "miramar"]
    assert maps[0]["display_name"] == "Erangel"
    assert maps[0]["coordinate"]["max_x"] == 816000
    assert maps[1]["display_name"] == "Karakin"
    assert maps[1]["telemetry_names"] == ["Summerland_Main"]
    assert maps[1]["coordinate"]["max_x"] == 204000
    assert maps[1]["assets"]["high"] == "Assets/Maps/Karakin_Main_High_Res.png"
    assert maps[2]["display_name"] == "Miramar"
    assert maps[2]["telemetry_names"] == ["Desert_Main"]
    assert maps[2]["assets"]["high"] == "Assets/Maps/Miramar_Main_High_Res.png"


def test_get_zone_phases_returns_supported_prediction_config() -> None:
    service = ConfigService(Path("config"))

    config = service.get_zone_phases("erangel")

    assert config["map_id"] == "erangel"
    assert config["game_mode"] == "default"
    assert config["config_version"] == "mvp-1"
    assert config["final_phase"] == 8
    assert config["supported_prediction_phases"] == [1, 2, 3, 4, 5, 6, 7]
    assert config["phases"][0]["phase"] == 1
    assert config["phases"][-1]["is_final_candidate"] is True


def test_get_zone_phases_supports_miramar() -> None:
    service = ConfigService(Path("config"))

    config = service.get_zone_phases("miramar")

    assert config["map_id"] == "miramar"
    assert config["final_phase"] == 8
    assert config["supported_prediction_phases"] == [1, 2, 3, 4, 5, 6, 7]
    assert config["phases"][0]["radius"] == 400000
    assert config["phases"][-1]["is_final_candidate"] is True


def test_get_zone_phases_supports_karakin() -> None:
    service = ConfigService(Path("config"))

    config = service.get_zone_phases("karakin")

    assert config["map_id"] == "karakin"
    assert config["final_phase"] == 8
    assert config["supported_prediction_phases"] == [1, 2, 3, 4, 5, 6, 7]
    assert config["phases"][0]["radius"] == 81445.68
    assert config["phases"][-1]["radius"] == 1539.32
