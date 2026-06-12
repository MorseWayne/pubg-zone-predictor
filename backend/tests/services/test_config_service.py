from pathlib import Path

from app.services.config_service import ConfigService


def test_list_maps_reads_yaml_config() -> None:
    service = ConfigService(Path("config"))

    maps = service.list_maps()

    map_ids = [map_config["map_id"] for map_config in maps]
    maps_by_id = {map_config["map_id"]: map_config for map_config in maps}

    assert map_ids == ["deston", "erangel", "karakin", "miramar", "paramo", "rondo", "sanhok", "taego", "vikendi"]
    assert maps_by_id["erangel"]["display_name"] == "Erangel"
    assert maps_by_id["erangel"]["coordinate"]["max_x"] == 816000
    assert maps_by_id["karakin"]["display_name"] == "Karakin"
    assert maps_by_id["karakin"]["telemetry_names"] == ["Summerland_Main"]
    assert maps_by_id["karakin"]["coordinate"]["max_x"] == 204000
    assert maps_by_id["karakin"]["assets"]["high"] == "Assets/Maps/Karakin_Main_High_Res.png"
    assert maps_by_id["miramar"]["display_name"] == "Miramar"
    assert maps_by_id["miramar"]["telemetry_names"] == ["Desert_Main"]
    assert maps_by_id["miramar"]["assets"]["high"] == "Assets/Maps/Miramar_Main_High_Res.png"
    assert maps_by_id["paramo"]["telemetry_names"] == ["Chimera_Main"]
    assert maps_by_id["paramo"]["coordinate"]["max_x"] == 306000
    assert maps_by_id["paramo"]["assets"]["high"] == "Assets/Maps/Paramo_Main_High_Res.png"
    assert maps_by_id["rondo"]["telemetry_names"] == ["Neon_Main"]
    assert maps_by_id["rondo"]["assets"]["high"] == "Assets/Maps/Rondo_Main_High_Res.png"
    assert maps_by_id["sanhok"]["telemetry_names"] == ["Savage_Main"]
    assert maps_by_id["sanhok"]["coordinate"]["max_x"] == 408000
    assert maps_by_id["sanhok"]["assets"]["high"] == "Assets/Maps/Sanhok_Main_High_Res.png"
    assert maps_by_id["taego"]["telemetry_names"] == ["Tiger_Main"]
    assert maps_by_id["taego"]["assets"]["high"] == "Assets/Maps/Taego_Main_High_Res.png"
    assert maps_by_id["vikendi"]["telemetry_names"] == ["DihorOtok_Main"]
    assert maps_by_id["vikendi"]["assets"]["high"] == "Assets/Maps/Vikendi_Main_High_Res.png"


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


def test_get_zone_phases_supports_added_official_maps() -> None:
    service = ConfigService(Path("config"))

    expected_first_radius = {
        "deston": 400000,
        "paramo": 150000,
        "rondo": 400000,
        "sanhok": 200000,
        "taego": 400000,
        "vikendi": 400000,
    }

    for map_id, first_radius in expected_first_radius.items():
        config = service.get_zone_phases(map_id)

        assert config["map_id"] == map_id
        assert config["final_phase"] == 8
        assert config["supported_prediction_phases"] == [1, 2, 3, 4, 5, 6, 7]
        assert config["phases"][0]["radius"] == first_radius
        assert config["phases"][-1]["is_final_candidate"] is True
