"""
Тесты обработчика голоса: поддельный HTTP-сервер на 127.0.0.1 и поддельный распознаватель.
Настоящая модель здесь не нужна и не грузится. Запуск:

    python -B -m unittest test_worker -v
"""
import contextlib
import io
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

import worker  # noqa: E402

TOKEN = "TOKEN-9f3a7c1e-SECRET-Zq81"
ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0"


def vid(n):
    return f"{ULID[:-2]}{n:02d}"


class FakeServer:
    """Минимальная копия контракта voice/*. Поведение каждой строки задаётся полями словаря."""

    def __init__(self):
        self.items = []  # {id, ext, data: bytes, claim: 200|409|500, file: 200|404|cut}
        self.requests = []  # (method, path, authorization, body)
        self.transcripts = {}
        self.failed = {}
        self.pending_status = 200
        self.pending_message = "Ошибка"
        self.redirect_pending = False
        self.transcript_status = 200
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def _reply(self, status, obj, extra=None):
                raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                for k, v in (extra or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(raw)

            def _body(self):
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b""
                return json.loads(raw.decode("utf-8")) if raw else None

            def _handle(self, method):
                body = self._body() if method == "POST" else None
                path = self.path
                outer.requests.append((method, path, self.headers.get("Authorization"), body))
                if path.startswith("/api/v1/voice/pending"):
                    if outer.redirect_pending:
                        return self._reply(302, {}, {"Location": "http://evil.example/steal"})
                    if outer.pending_status != 200:
                        return self._reply(outer.pending_status, {"message": outer.pending_message})
                    items = [{"id": i["id"], "ext": i["ext"], "size_bytes": len(i["data"])} for i in outer.items]
                    return self._reply(200, {"items": items})
                m = re.match(r"^/api/v1/voice/([^/]+)/(claim|file|transcript|failed)$", path)
                item = next((i for i in outer.items if m and i["id"] == m.group(1)), None)
                if not m or item is None:
                    return self._reply(404, {"message": "Такого адреса нет."})
                action = m.group(2)
                if action == "claim":
                    if item["claim"] != 200:
                        return self._reply(item["claim"], {"message": "Уже взято."})
                    return self._reply(200, {"id": item["id"]})
                if action == "file":
                    if item["file"] == 404:
                        return self._reply(404, {"message": "Файл недоступен."})
                    if item["file"] == "cut":
                        self.send_response(200)
                        self.send_header("Content-Length", str(len(item["data"]) + 500))
                        self.end_headers()
                        self.wfile.write(item["data"])
                        self.close_connection = True
                        return None
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(item["data"])))
                    self.end_headers()
                    self.wfile.write(item["data"])
                    return None
                if action == "transcript":
                    if outer.transcript_status != 200:
                        return self._reply(outer.transcript_status, {"message": "Не в обработке."})
                    outer.transcripts[item["id"]] = body["text"]
                    return self._reply(200, {"id": item["id"]})
                outer.failed[item["id"]] = body["reason"]
                return self._reply(200, {"id": item["id"]})

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def add(self, n, data=b"OK-audio", ext="oga", claim=200, file=200):
        self.items.append({"id": vid(n), "ext": ext, "data": data, "claim": claim, "file": file})
        return vid(n)

    def paths(self, kind):
        return [p for (_, p, _, _) in self.requests if p.endswith("/" + kind)]

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


class FakeRecognizer:
    """Текст зависит от содержимого файла: BAD падает с путём в сообщении, EMPTY даёт пустую строку."""

    def __init__(self):
        self.closed = False

    def describe(self):
        return "fake"

    def transcribe(self, path):
        data = Path(path).read_bytes()
        if data.startswith(b"BAD"):
            raise RuntimeError(f"не прочитан {path} в C:\\Users\\Boris\\secret")
        if data.startswith(b"EMPTY"):
            return worker.Recognition("   ", "short", 1.0)
        return worker.Recognition(f"Секретная расшифровка {Path(path).stem}", "short", 4.2)

    def close(self):
        self.closed = True


class Factory:
    def __init__(self, fail=False):
        self.calls = 0
        self.fail = fail
        self.recognizer = FakeRecognizer()

    def __call__(self, model, workdir):
        self.calls += 1
        if self.fail:
            raise MemoryError("CUDA out of memory, путь D:\\x")
        return self.recognizer


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.data = self.tmp / "data"
        self.cwd = self.tmp / "cwd"
        self.tmpdir = self.tmp / "tmpdir"
        self.cwd.mkdir()
        self.tmpdir.mkdir()
        self.old_cwd = os.getcwd()
        os.chdir(self.cwd)
        self.old_tmp = tempfile.tempdir
        tempfile.tempdir = str(self.tmpdir)
        self.server = FakeServer().__enter__()
        self.factory = Factory()

    def tearDown(self):
        self.server.__exit__(None, None, None)
        tempfile.tempdir = self.old_tmp
        os.chdir(self.old_cwd)
        self._tmp.cleanup()

    def env(self, **extra):
        env = {
            "PULT_SERVER": self.server.url,
            "PULT_TOKEN": TOKEN,
            "PULT_CONFIG": str(self.tmp / "no-config.json"),
            "LOCALAPPDATA": str(self.tmp / "localappdata"),
            "APPDATA": str(self.tmp / "appdata"),
        }
        env.update(extra)
        return env

    def go(self, extra_args=(), env=None, factory=None):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = worker.run(["--data-dir", str(self.data), *extra_args], env=env or self.env(),
                              recognizer_factory=factory or self.factory)
        return code, out.getvalue() + err.getvalue()

    def everything(self, output):
        """Весь вывод плюс каждый файл в data-dir: то, где мог бы оказаться секрет."""
        blob = output
        if self.data.exists():
            for p in self.data.rglob("*"):
                if p.is_file():
                    blob += "\n" + p.read_bytes().decode("utf-8", "replace")
        return blob

    def log_text(self):
        return "".join(p.read_text(encoding="utf-8") for p in (self.data / "logs").glob("voice-*.log"))


class QueueAndModel(Base):
    def test_empty_queue_does_not_load_model(self):
        code, out = self.go()
        self.assertEqual(code, 0)
        self.assertEqual(self.factory.calls, 0, "модель загружена при пустой очереди")
        self.assertFalse((self.data / "worker.lock").exists())
        self.assertEqual(self.server.paths("claim"), [])

    def test_lost_claim_409_is_skipped_quietly(self):
        a = self.server.add(1, claim=409)
        b = self.server.add(2)
        code, out = self.go()
        self.assertEqual(code, 0)
        self.assertNotIn(a, self.server.transcripts)
        self.assertNotIn(a, self.server.failed)
        self.assertEqual([p for p in self.server.paths("file") if a in p], [], "проигранный claim не должен качать файл")
        self.assertEqual(self.server.transcripts[b], f"Секретная расшифровка {b}")

    def test_success_posts_transcript_and_files_land_in_done(self):
        a = self.server.add(1)
        code, out = self.go()
        self.assertEqual(code, 0)
        self.assertEqual(self.server.transcripts[a], f"Секретная расшифровка {a}")
        self.assertEqual((self.data / "done" / f"{a}.txt").read_text(encoding="utf-8"), f"Секретная расшифровка {a}")
        self.assertEqual((self.data / "done" / f"{a}.oga").read_bytes(), b"OK-audio")
        self.assertEqual(list((self.data / "work").iterdir()), [])
        self.assertEqual(list(self.data.rglob("*.part")), [])
        self.assertTrue(self.factory.recognizer.closed, "модель не выгружена")
        self.assertFalse((self.data / "worker.lock").exists(), "замок остался после прохода")

    def test_failure_posts_failed_and_continues(self):
        bad = self.server.add(1, data=b"BAD-audio")
        good = self.server.add(2)
        code, out = self.go()
        self.assertEqual(code, 0)
        self.assertIn(bad, self.server.failed)
        reason = self.server.failed[bad]
        for leak in ("Users", "Boris", "secret", "C:\\", str(self.tmp)):
            self.assertNotIn(leak, reason, "в причине для сервера путь пользователя")
        self.assertEqual(self.server.transcripts[good], f"Секретная расшифровка {good}")
        self.assertEqual((self.data / "failed" / f"{bad}.oga").read_bytes(), b"BAD-audio", "не прошедший файл не оставлен")
        self.assertTrue((self.data / "failed" / f"{bad}.reason.txt").exists())

    def test_empty_recognition_is_failed_not_empty_text(self):
        a = self.server.add(1, data=b"EMPTY")
        code, out = self.go()
        self.assertNotIn(a, self.server.transcripts)
        self.assertIn("не дало текста", self.server.failed[a])

    def test_model_load_failure_takes_nothing(self):
        self.server.add(1)
        code, out = self.go(factory=Factory(fail=True))
        self.assertEqual(code, worker.EXIT_MODEL)
        self.assertEqual(self.server.paths("claim"), [], "до загрузки модели ничего не берётся")
        self.assertFalse((self.data / "worker.lock").exists())
        self.assertNotIn("D:\\x", out)

    def test_file_404_reports_failed(self):
        a = self.server.add(1, file=404)
        code, out = self.go()
        self.assertIn("недоступен", self.server.failed[a])

    def test_truncated_download_aborts_run_without_loss(self):
        a = self.server.add(1, file="cut")
        b = self.server.add(2)
        code, out = self.go()
        self.assertEqual(code, worker.EXIT_NETWORK)
        self.assertEqual(self.server.transcripts, {})
        self.assertEqual(self.server.failed, {}, "обрыв связи не должен объявляться сбоем распознавания")
        self.assertEqual([p for p in self.server.paths("claim") if b in p], [], "после обрыва вторую не берём")
        self.assertEqual(list((self.data / "work").iterdir()), [])
        self.assertFalse((self.data / "worker.lock").exists())

    def test_transcript_409_keeps_files_in_work(self):
        a = self.server.add(1)
        self.server.transcript_status = 409
        code, out = self.go()
        self.assertEqual(code, 0)
        self.assertTrue((self.data / "work" / f"{a}.txt").exists())
        self.assertFalse((self.data / "done" / f"{a}.txt").exists())

    def test_server_sends_only_expected_requests(self):
        a = self.server.add(1)
        self.go()
        methods = [(m, p.split("?")[0].replace(a, "ID")) for (m, p, _, _) in self.server.requests]
        self.assertEqual(methods, [
            ("GET", "/api/v1/voice/pending"),
            ("POST", "/api/v1/voice/ID/claim"),
            ("GET", "/api/v1/voice/ID/file"),
            ("POST", "/api/v1/voice/ID/transcript"),
        ])
        self.assertTrue(all(auth == f"Bearer {TOKEN}" for (_, _, auth, _) in self.server.requests))


class LockTests(Base):
    def _write_lock(self, pid, started=None):
        self.data.mkdir(parents=True, exist_ok=True)
        (self.data / "worker.lock").write_text(json.dumps({"pid": pid, "started": started or time.time()}))

    def test_live_lock_exits_at_once(self):
        self.server.add(1)
        sleeper = subprocess.Popen([sys.executable, "-B", "-c", "import time; time.sleep(120)"])
        try:
            self._write_lock(sleeper.pid)
            code, out = self.go()
            self.assertEqual(code, 0)
            self.assertEqual(self.factory.calls, 0, "модель загружена при живом замке")
            self.assertEqual(self.server.paths("claim"), [])
            self.assertEqual(json.loads((self.data / "worker.lock").read_text())["pid"], sleeper.pid, "чужой замок тронут")
        finally:
            sleeper.kill()
            sleeper.wait()

    def test_dead_lock_is_removed_and_work_done(self):
        a = self.server.add(1)
        dead = subprocess.Popen([sys.executable, "-B", "-c", "pass"])
        dead.wait()
        self._write_lock(dead.pid)
        code, out = self.go()
        self.assertEqual(code, 0)
        self.assertIn(a, self.server.transcripts)
        self.assertFalse((self.data / "worker.lock").exists())

    def test_ancient_lock_of_reused_pid_is_removed(self):
        a = self.server.add(1)
        self._write_lock(os.getpid(), started=time.time() - 7 * 3600)
        code, out = self.go()
        self.assertIn(a, self.server.transcripts)

    def test_garbage_lock_old_is_removed(self):
        a = self.server.add(1)
        self.data.mkdir(parents=True, exist_ok=True)
        lock = self.data / "worker.lock"
        lock.write_bytes("мусор".encode("cp1251"))
        old = time.time() - 600
        os.utime(lock, (old, old))
        code, out = self.go()
        self.assertIn(a, self.server.transcripts)


class SecurityTests(Base):
    def test_http_to_external_host_refused(self):
        env = self.env(PULT_SERVER="http://example.com")
        code, out = self.go(env=env)
        self.assertEqual(code, worker.EXIT_CONFIG)
        self.assertIn("Отказ", out)
        self.assertEqual(self.server.requests, [])
        self.assertEqual(self.factory.calls, 0)

    def test_normalize_server_rules(self):
        n = worker.normalize_server
        self.assertEqual(n("https://team.example.org/"), "https://team.example.org")
        self.assertEqual(n("https://team.example.org/api/v1"), "https://team.example.org")
        self.assertEqual(n("http://localhost:8000"), "http://localhost:8000")
        self.assertEqual(n("http://127.0.0.1:8000"), "http://127.0.0.1:8000")
        self.assertEqual(n("http://pult.test"), "http://pult.test")
        self.assertEqual(n("http://[::1]:8000"), "http://[::1]:8000")
        for bad in ("http://example.com", "http://127.0.0.1.evil.com", "http://localhost.evil.com",
                    "http://notatest.test.evil.com", "ftp://x.test", "https://user:pw@x.org", "https://x.org/?a=1", "", None):
            with self.assertRaises(worker.ConfigError, msg=str(bad)):
                n(bad)

    def test_https_external_accepted_by_settings(self):
        server, token = worker.resolve_settings({"PULT_SERVER": "https://team.example.org", "PULT_TOKEN": " t "})
        self.assertEqual((server, token), ("https://team.example.org", "t"))

    def test_settings_from_config_file_and_env_wins(self):
        cfg = self.tmp / "c.json"
        cfg.write_bytes("\ufeff".encode("utf-8") + json.dumps({"server": "https://file.example.org", "token": "from-file"}).encode())
        self.assertEqual(worker.resolve_settings({"PULT_CONFIG": str(cfg)}), ("https://file.example.org", "from-file"))
        self.assertEqual(worker.resolve_settings({"PULT_CONFIG": str(cfg), "PULT_SERVER": "https://env.example.org", "PULT_TOKEN": "from-env"}),
                         ("https://env.example.org", "from-env"))

    def test_corrupt_config_does_not_print_content(self):
        cfg = self.tmp / "c.json"
        cfg.write_text('{"token": "' + TOKEN + '" oops', encoding="utf-8")
        code, out = self.go(env={"PULT_CONFIG": str(cfg)})
        self.assertEqual(code, worker.EXIT_CONFIG)
        self.assertNotIn(TOKEN, self.everything(out))

    def test_missing_token_is_config_error(self):
        code, out = self.go(env=self.env(PULT_TOKEN=""))
        self.assertEqual(code, worker.EXIT_CONFIG)

    def test_token_never_in_output_or_files_on_any_error(self):
        scenarios = []

        def refused():
            s = socket.socket()
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
            s.close()
            return {"PULT_SERVER": f"http://127.0.0.1:{port}"}

        scenarios.append(("refused", refused, lambda: None))

        def s401():
            self.server.pending_status = 401
            self.server.pending_message = f"Токен {TOKEN} не принят"
        scenarios.append(("401-echo", lambda: {}, s401))

        def s500():
            self.server.pending_status = 500
            self.server.pending_message = f"сбой при Bearer {TOKEN}"
        scenarios.append(("500-echo", lambda: {}, s500))

        def redirect():
            self.server.redirect_pending = True
        scenarios.append(("redirect", lambda: {}, redirect))

        def claim500():
            self.server.add(1, claim=500)
        scenarios.append(("claim500", lambda: {}, claim500))

        def cut():
            self.server.add(1, file="cut")
        scenarios.append(("cut", lambda: {}, cut))

        def t409():
            self.server.add(1)
            self.server.transcript_status = 409
        scenarios.append(("transcript409", lambda: {}, t409))

        def bad():
            self.server.add(1, data=b"BAD")
        scenarios.append(("recognizer-error", lambda: {}, bad))

        for name, env_extra, prepare in scenarios:
            with self.subTest(name):
                self.server.items.clear()
                self.server.pending_status, self.server.redirect_pending, self.server.transcript_status = 200, False, 200
                prepare()
                code, out = self.go(env=self.env(**env_extra()))
                blob = self.everything(out)
                self.assertNotIn(TOKEN, blob, "токен попал в вывод или файлы")
                self.assertNotIn(TOKEN[:12], blob)
                if name == "redirect":
                    self.assertEqual([p for (_, p, _, _) in self.server.requests if "evil" in p], [])

    def test_transcript_text_not_in_log_or_output(self):
        a = self.server.add(1)
        b = self.server.add(2, data=b"BAD")
        code, out = self.go()
        text = f"Секретная расшифровка {a}"
        log = self.log_text()
        self.assertIn(a, log, "id в журнале должен быть")
        self.assertIn("audio=4.2s", log, "длительность в журнале должна быть")
        self.assertNotIn("Секретная расшифровка", log)
        self.assertNotIn("Секретная расшифровка", out)
        # и текст лежит только рядом с аудио, в done/
        holders = [p.name for p in self.data.rglob("*") if p.is_file() and text.encode() in p.read_bytes()]
        self.assertEqual(holders, [f"{a}.txt"])

    def test_nothing_written_outside_data_dir(self):
        self.server.add(1)
        self.server.add(2, data=b"BAD")
        self.go()
        self.assertEqual(list(self.cwd.iterdir()), [], "что-то записано в рабочий каталог")
        self.assertEqual(list(self.tmpdir.iterdir()), [], "что-то записано во временный каталог")
        self.assertFalse((self.tmp / "localappdata").exists(), "каталог по умолчанию создан несмотря на --data-dir")
        self.assertEqual(sorted(p.name for p in self.tmp.iterdir()), ["cwd", "data", "tmpdir"])


class CleanupTests(Base):
    def test_old_done_removed_new_and_failed_kept(self):
        self.go()  # создать каталоги
        day = 86400
        old, fresh = time.time() - 40 * day, time.time() - 10 * day
        files = {
            self.data / "done" / "old.txt": old,
            self.data / "done" / "fresh.txt": fresh,
            self.data / "failed" / "old.oga": old,
            self.data / "work" / "stale.oga": time.time() - 3 * day,
            self.data / "work" / "recent.oga": time.time() - 3600,
        }
        for p, t in files.items():
            p.write_bytes(b"x")
            os.utime(p, (t, t))
        code, out = self.go()
        self.assertFalse((self.data / "done" / "old.txt").exists())
        self.assertTrue((self.data / "done" / "fresh.txt").exists())
        self.assertTrue((self.data / "failed" / "old.oga").exists(), "разбираемое удалять нельзя")
        self.assertFalse((self.data / "work" / "stale.oga").exists())
        self.assertTrue((self.data / "work" / "recent.oga").exists())

    def test_keep_days_is_configurable(self):
        self.go()
        p = self.data / "done" / "a.txt"
        p.write_bytes(b"x")
        t = time.time() - 10 * 86400
        os.utime(p, (t, t))
        self.go(extra_args=["--keep-days", "5"])
        self.assertFalse(p.exists())


class ChunkPlanTests(unittest.TestCase):
    """Нарезка длинных записей (чистый Python, без модели)."""

    def energy(self, spec):
        """spec: [(секунд, 'речь'|'тишина')] -> db по кадрам 10 мс."""
        db = []
        for sec, kind in spec:
            level = -20.0 if kind == "s" else -60.0
            db.extend([level + (i % 3) for i in range(int(sec * 100))])
        return db

    def test_cuts_in_the_pauses_and_respects_max(self):
        # 10 фраз по 6 с речи, между ними пауза 2 с (четверть записи: «пол шума» по пятому процентилю)
        spec = []
        for _ in range(10):
            spec += [(6.0, "s"), (2.0, "q")]
        db = self.energy([(s, "s" if k == "s" else "t") for s, k in spec])
        chunks = worker.plan_chunks(db)
        self.assertTrue(all(b - a <= 22.0 + 1e-6 for a, b in chunks), chunks)
        self.assertEqual(chunks[0][0], 0.0)
        self.assertAlmostEqual(chunks[-1][1], len(db) / 100, delta=0.02)
        for (a1, b1), (a2, b2) in zip(chunks, chunks[1:]):
            self.assertEqual(b1, a2, "куски должны стыковаться без дыр и перекрытий")
        for a, b in chunks[:-1]:
            cut_frame = int(round(b * 100))
            self.assertLess(db[cut_frame], -50, f"разрез на {b} с попал в речь")

    def test_no_pause_cuts_at_quietest_point(self):
        db = [-20.0 + (i % 3) for i in range(60 * 100)]
        for i in range(int(17.0 * 100), int(17.0 * 100) + 15):  # провал на 150 мс: не пауза, но тише всего
            db[i] = -45.0
        chunks = worker.plan_chunks(db)
        self.assertTrue(all(b - a <= 22.0 + 1e-6 for a, b in chunks))
        self.assertAlmostEqual(chunks[0][1], 17.075, delta=0.1)

    def test_pure_silence_gives_no_chunks(self):
        self.assertEqual(worker.plan_chunks([-60.0 + (i % 2) for i in range(40 * 100)]), [])

    def test_empty(self):
        self.assertEqual(worker.plan_chunks([]), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
