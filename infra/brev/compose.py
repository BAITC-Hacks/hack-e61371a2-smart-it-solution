#!/usr/bin/env python3
"""Run the app and Brev tunnel with the base environment preserved.

The optional repository .env is passed before .env.brev. This script never reads
or writes either file; Docker Compose applies its normal interpolation rules.
"""
import argparse
from pathlib import Path
import subprocess
import sys


def build_command(root, compose_args, *, base_env_file=None, cwd=None):
    """Build an argument list without invoking Docker or reading configuration."""
    root = Path(root).resolve()
    if not compose_args:
        raise ValueError("Provide a Compose command, for example: up -d --build --wait")
    overlay = root / ".env.brev"
    if not overlay.is_file():
        raise ValueError("Missing .env.brev. Prepare the private connection with infra/brev/connect.py first.")
    base = root / ".env"
    if base_env_file is not None:
        base = Path(base_env_file)
        if not base.is_absolute():
            base = Path(cwd or Path.cwd()) / base
        base = base.resolve()
        if not base.is_file():
            raise ValueError("The file supplied with --base-env-file does not exist or is not a file.")
    elif base.exists() and not base.is_file():
        raise ValueError("Repository .env exists but is not a file.")
    command = ["docker", "compose", "--project-directory", str(root)]
    if base.is_file():
        command.extend(["--env-file", str(base)])
    command.extend(["--env-file", str(overlay), "-f", str(root / "compose.yaml"),
                    "-f", str(root / "compose.brev.yaml"), *compose_args])
    return command


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-env-file", metavar="PATH",
                        help="Use this base environment instead of repository .env; relative to the current directory.")
    parser.add_argument("compose_args", nargs=argparse.REMAINDER,
                        help="Compose command and arguments, for example: up -d --build --wait")
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parents[2]
    try:
        command = build_command(root, args.compose_args, base_env_file=args.base_env_file)
    except ValueError as error:
        parser.error(str(error))
    try:
        return subprocess.run(command, cwd=root, check=False).returncode
    except FileNotFoundError:
        print("Docker is not available. Install Docker with the Compose plugin and make docker available on PATH.", file=sys.stderr)
        return 127
    except OSError:
        print("Could not start Docker. Check its installation and execution permissions.", file=sys.stderr)
        return 126
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
