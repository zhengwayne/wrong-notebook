import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class ComposeSecretTests(unittest.TestCase):
    def test_source_template_leaves_instance_secret_empty(self):
        values = [
            line.split("=", 1)[1].strip().strip("\"'")
            for line in (ROOT / ".env.example").read_text().splitlines()
            if line.startswith("NEXTAUTH_SECRET=")
        ]
        self.assertEqual(values, [""])

    def test_both_manifests_require_and_forward_the_deployment_secret(self):
        for command in (["docker", "compose"], ["docker-compose"]):
            if shutil.which(command[0]) and subprocess.run(
                [*command, "version"], capture_output=True
            ).returncode == 0:
                break
        else:
            self.skipTest("未安装 Docker Compose")

        # 使用合成环境和独立的 Compose 目录，只解析清单，不启动服务。
        env = {"PATH": os.environ["PATH"]}
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            for name in ("docker-compose.yml", "docker-compose.https.yml"):
                with self.subTest(manifest=name):
                    shutil.copyfile(ROOT / name, work / name)
                    args = [*command, "-f", name, "config"]
                    for contents in ("", "NEXTAUTH_SECRET=\n"):
                        (work / ".env").write_text(contents)
                        missing = subprocess.run([*args, "--quiet"], cwd=work, env=env, capture_output=True)
                        self.assertNotEqual(missing.returncode, 0)
                        self.assertIn(b"NEXTAUTH_SECRET", missing.stderr)
                    secret = secrets.token_hex(32)
                    parsed = subprocess.run(
                        [*args, "--format", "json"], cwd=work,
                        env={**env, "NEXTAUTH_SECRET": secret}, capture_output=True, check=True,
                    )
                    service = json.loads(parsed.stdout)["services"]["wrong-notebook"]
                    self.assertTrue(service["environment"]["NEXTAUTH_SECRET"] == secret)
