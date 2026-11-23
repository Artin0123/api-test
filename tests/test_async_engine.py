import asyncio
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent


def load_async_engine():
    """Import async_test_keys with a minimal aiohttp stub so unit tests stay offline."""
    if "async_test_keys" in sys.modules:
        return sys.modules["async_test_keys"]
    if "aiohttp" not in sys.modules:
        fake_aiohttp = types.ModuleType("aiohttp")

        class ClientTimeout:
            def __init__(self, total=None):
                self.total = total

        class ClientSession:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

        fake_aiohttp.ClientTimeout = ClientTimeout
        fake_aiohttp.ClientSession = ClientSession
        sys.modules["aiohttp"] = fake_aiohttp
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    import async_test_keys

    return async_test_keys


class _FakeResponse:
    def __init__(self, status, body):
        self.status = status
        self._body = body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def text(self):
        return self._body


class AsyncEngineRegressionTests(unittest.TestCase):
    def test_http_200_non_json_body_surfaces_error_detail(self):
        engine = load_async_engine()

        class FakeSession:
            def post(self, *args, **kwargs):
                return _FakeResponse(200, "<html>challenge page</html>")

        result = asyncio.run(
            engine.test_single_request(
                FakeSession(),
                key="sk-test",
                model="gpt-4o",
                provider_type="openai",
                api_base="https://mock.example",
                test_path="/v1/chat/completions",
            )
        )
        success, status, err, *_ = result
        self.assertFalse(success)
        self.assertEqual(status, 200)
        self.assertEqual(err, "<html>challenge page</html>")
        self.assertEqual(
            engine.parse_error_body(err),
            {"raw": "<html>challenge page</html>"},
        )

    def test_checkpoint_resume_preserves_401_error_code_and_detail(self):
        engine = load_async_engine()
        with tempfile.TemporaryDirectory() as tmpdir:
            cwd = os.getcwd()
            os.chdir(tmpdir)
            try:
                ckpt_path = Path(tmpdir) / "checkpoint.json"
                out_path = Path(tmpdir) / "out.json"
                ckpt_data = {
                    "provider_type": "openai",
                    "api_base": "https://resume.example",
                    "total_tasks": 4,
                    "completed_tasks": 2,
                    "dead_keys": ["sk-dead-401"],
                    "results": {
                        "sk-dead-401": [
                            {
                                "model": "m1",
                                "success": False,
                                "status": 401,
                                "error": '{"error":{"message":"invalid key provided"}}',
                                "error_detail": {"message": "invalid key provided"},
                                "avg_total": None,
                                "has_thinking": False,
                                "has_content": False,
                                "answer_verified": False,
                                "sample_content": "",
                                "sample_thinking": "",
                            }
                        ],
                        "sk-good": [
                            {
                                "model": "m1",
                                "success": True,
                                "status": 200,
                                "error": "",
                                "error_detail": None,
                                "avg_total": 0.5,
                                "has_thinking": False,
                                "has_content": True,
                                "answer_verified": True,
                                "sample_content": "323",
                                "sample_thinking": "",
                            }
                        ],
                    },
                }
                ckpt_path.write_text(json.dumps(ckpt_data), encoding="utf-8")

                class FakeSession:
                    async def __aenter__(self):
                        return self

                    async def __aexit__(self, *args):
                        return False

                    def post(self, *args, **kwargs):
                        return _FakeResponse(
                            200,
                            json.dumps(
                                {"choices": [{"message": {"content": "323"}}]}
                            ),
                        )

                with (
                    mock.patch.object(engine, "CHECKPOINT_PATH", str(ckpt_path)),
                    mock.patch.object(engine, "OUTPUT_JSON_PATH", str(out_path)),
                    mock.patch.object(
                        engine.aiohttp, "ClientSession", return_value=FakeSession()
                    ),
                ):
                    asyncio.run(
                        engine.run_provider(
                            api_base="https://resume.example",
                            provider_type="openai",
                            keys=["sk-dead-401", "sk-good"],
                            models=["m1", "m2"],
                            test_path="/v1/chat/completions",
                        )
                    )

                report = json.loads(out_path.read_text(encoding="utf-8"))
                self.assertEqual(report["valid_keys"], ["sk-good"])
                self.assertEqual(len(report["invalid_records"]), 1)
                rec = report["invalid_records"][0]
                self.assertEqual(rec["api_key"], "sk-dead-401")
                self.assertEqual(rec["error_code"], 401)
                self.assertEqual(rec["error_reason"], "invalid key provided")
                self.assertEqual(
                    rec["error_detail"], {"message": "invalid key provided"}
                )
                self.assertFalse(ckpt_path.exists())
            finally:
                os.chdir(cwd)

    def test_provider_finish_keeps_checkpoint_belonging_to_other_provider(self):
        engine = load_async_engine()
        with tempfile.TemporaryDirectory() as tmpdir:
            ckpt_path = Path(tmpdir) / "checkpoint.json"
            out_path = Path(tmpdir) / "out.json"
            other_ckpt = {
                "provider_type": "anthropic",
                "api_base": "https://other.example",
                "total_tasks": 2,
                "completed_tasks": 1,
                "dead_keys": [],
                "results": {},
            }
            ckpt_path.write_text(json.dumps(other_ckpt), encoding="utf-8")

            class FakeSession:
                async def __aenter__(self):
                    return self

                async def __aexit__(self, *args):
                    return False

                def post(self, *args, **kwargs):
                    return _FakeResponse(
                        200, json.dumps({"choices": [{"message": {"content": "323"}}]})
                    )

            with (
                mock.patch.object(engine, "CHECKPOINT_PATH", str(ckpt_path)),
                mock.patch.object(engine, "OUTPUT_JSON_PATH", str(out_path)),
                mock.patch.object(
                    engine.aiohttp, "ClientSession", return_value=FakeSession()
                ),
            ):
                asyncio.run(
                    engine.run_provider(
                        api_base="https://first.example",
                        provider_type="openai",
                        keys=["sk-1", "sk-2"],
                        models=["m1"],
                        test_path="/v1/chat/completions",
                    )
                )

            self.assertTrue(ckpt_path.exists())
            saved = json.loads(ckpt_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["api_base"], "https://other.example")

    def test_timeout_error_records_status_499_and_counts_timeout_stats(self):
        engine = load_async_engine()

        class TimeoutSession:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            def post(self, *args, **kwargs):
                raise asyncio.TimeoutError()

        with tempfile.TemporaryDirectory() as tmpdir:
            out_path = Path(tmpdir) / "out.json"
            ckpt_path = Path(tmpdir) / "checkpoint.json"
            with (
                mock.patch.object(engine, "CHECKPOINT_PATH", str(ckpt_path)),
                mock.patch.object(engine, "OUTPUT_JSON_PATH", str(out_path)),
                mock.patch.object(
                    engine.aiohttp, "ClientSession", return_value=TimeoutSession()
                ),
            ):
                asyncio.run(
                    engine.run_provider(
                        api_base="https://timeout.example",
                        provider_type="openai",
                        keys=["sk-timeout-1", "sk-timeout-2"],
                        models=["m-timeout"],
                        test_path="/v1/chat/completions",
                    )
                )

            report = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertEqual(len(report["invalid_records"]), 2)
            for rec in report["invalid_records"]:
                self.assertEqual(rec["error_code"], 499)
            self.assertEqual(
                report["model_performance"]["m-timeout"]["timeout_count"], 2
            )


if __name__ == "__main__":
    unittest.main()
