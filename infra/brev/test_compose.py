"""Offline wrapper tests: no configuration contents, Docker, SSH or GPU access."""
import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("brev_compose", Path(__file__).with_name("compose.py"))
compose = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compose)


class ComposeCommandTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve() / "test project Қосылым"
        self.root.mkdir()
        (self.root / ".env.brev").touch()

    def test_base_precedes_ai_overlay_without_reading_contents(self):
        (self.root / ".env").touch()
        with patch.object(Path, "read_text", side_effect=AssertionError("must not read env contents")):
            result = compose.build_command(self.root, ["up", "-d", "--build", "--wait"])
        self.assertEqual(result, ["docker", "compose", "--project-directory", str(self.root),
                         "--env-file", str(self.root / ".env"), "--env-file", str(self.root / ".env.brev"),
                         "-f", str(self.root / "compose.yaml"), "-f", str(self.root / "compose.brev.yaml"),
                         "up", "-d", "--build", "--wait"])

    def test_default_base_is_optional(self):
        result = compose.build_command(self.root, ["ps"])
        self.assertEqual(result.count("--env-file"), 1)
        self.assertIn(str(self.root / ".env.brev"), result)

    def test_explicit_base_resolves_from_calling_directory_and_replaces_default(self):
        (self.root / ".env").touch()
        base = Path(self.directory.name).resolve() / "custom config.env"
        base.touch()
        result = compose.build_command(self.root, ["stop", "ai-tunnel"],
                                       base_env_file=base.name, cwd=self.directory.name)
        self.assertEqual(result[5], str(base))
        self.assertNotIn(str(self.root / ".env"), result)
        self.assertEqual(result[-2:], ["stop", "ai-tunnel"])

    def test_explicit_missing_base_fails_before_launch(self):
        with self.assertRaisesRegex(ValueError, "--base-env-file"):
            compose.build_command(self.root, ["ps"], base_env_file=self.root / "missing.env")

    def test_missing_overlay_fails_before_launch(self):
        (self.root / ".env.brev").unlink()
        with self.assertRaisesRegex(ValueError, "Missing .env.brev"):
            compose.build_command(self.root, ["up"])

    def test_default_base_directory_does_not_silently_drop_configuration(self):
        (self.root / ".env").mkdir()
        with self.assertRaisesRegex(ValueError, "not a file"):
            compose.build_command(self.root, ["up"])

    def test_command_is_required(self):
        with self.assertRaisesRegex(ValueError, "Provide a Compose command"):
            compose.build_command(self.root, [])

    def test_exec_arguments_are_forwarded_without_shell_interpretation(self):
        args = ["exec", "-T", "back", "node", "-e", "console.log('a; $(example)')"]
        result = compose.build_command(self.root, args)
        self.assertEqual(result[-len(args):], args)

    def test_main_runs_argument_list_and_returns_docker_status(self):
        command = ["docker", "compose", "ps"]
        with patch.object(compose, "build_command", return_value=command), \
                patch.object(compose.subprocess, "run") as run:
            run.return_value.returncode = 7
            self.assertEqual(compose.main(["ps"]), 7)
        self.assertEqual(run.call_args.args, (command,))
        self.assertFalse(run.call_args.kwargs.get("shell", False))

    def test_missing_docker_has_actionable_error(self):
        stderr = io.StringIO()
        with patch.object(compose, "build_command", return_value=["docker", "compose", "ps"]), \
                patch.object(compose.subprocess, "run", side_effect=FileNotFoundError), \
                contextlib.redirect_stderr(stderr):
            self.assertEqual(compose.main(["ps"]), 127)
        self.assertIn("Docker is not available", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
