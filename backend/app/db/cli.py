from argparse import ArgumentParser
from pathlib import Path

from app.db.migrations import initialize_database


def main() -> None:
    parser = ArgumentParser(description="Manage PUBG Zone Predictor local SQLite database")
    subparsers = parser.add_subparsers(dest="command", required=True)

    migrate_parser = subparsers.add_parser("migrate", help="Apply pending SQLite migrations")
    migrate_parser.add_argument(
        "--database-path",
        type=Path,
        default=None,
        help="Override APP_DATABASE_PATH for this migration run",
    )

    args = parser.parse_args()
    if args.command == "migrate":
        applied = initialize_database(args.database_path)
        if applied:
            for migration in applied:
                print(f"Applied migration {migration.version}: {migration.name}")
        else:
            print("Database is already up to date")


if __name__ == "__main__":
    main()
