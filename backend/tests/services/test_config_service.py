from pathlib import Path

from app.services.config_service import ConfigService


def test_list_maps_reads_yaml_config() -> None:
    service = ConfigService(Path("config"))

    maps = service.list_maps()

    assert maps[0]["map_id"] == "erangel"
    assert maps[0]["display_name"] == "Erangel"
    assert maps[0]["coordinate"]["max_x"] == 816000


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
