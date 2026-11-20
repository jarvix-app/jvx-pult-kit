"""
Живая проверка связки: поддельный сервер из тестов, но НАСТОЯЩАЯ модель GigaAM.

    D:\\gigaam-test\\.venv\\Scripts\\python.exe -B smoke_real.py <аудио> [<аудио> ...] [--data-dir КАТАЛОГ]

Файлы отдаются «серверу» как голосовые; worker.run идёт тем же путём, что в бою. В конце печатается
начало распознанного текста: это личные записи, если вы дали личные файлы, поэтому на тестовых
данных. Сюда не нужен ни токен, ни настоящий сервер.
"""
import sys

sys.dont_write_bytecode = True

import argparse
import hashlib
import os
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import worker  # noqa: E402
from test_worker import TOKEN, FakeServer, vid  # noqa: E402


class Reporting(worker.GigaamRecognizer):
    def close(self):
        t = self._torch
        if self.device.startswith("cuda"):
            print(f"[smoke] пик памяти видеокарты процессом: {t.cuda.max_memory_allocated() / 1e9:.2f} ГБ", flush=True)
        super().close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--data-dir", default=None)
    args = ap.parse_args()

    tmp = tempfile.TemporaryDirectory()
    data_dir = args.data_dir or str(Path(tmp.name) / "data")
    t0 = time.perf_counter()
    with FakeServer() as server:
        for n, f in enumerate(args.files, 1):
            ext = Path(f).suffix.lstrip(".").lower()
            server.add(n, data=Path(f).read_bytes(), ext=ext)
        env = dict(os.environ, PULT_SERVER=server.url, PULT_TOKEN=TOKEN, PULT_CONFIG=str(Path(tmp.name) / "none.json"))
        code = worker.run(
            ["--data-dir", data_dir],
            env=env,
            recognizer_factory=lambda model, workdir: Reporting(model, workdir=workdir),
        )
        wall = time.perf_counter() - t0
        print(f"\n[smoke] код выхода {code}, весь проход {wall:.1f} с")
        names = {vid(n): Path(f).name for n, f in enumerate(args.files, 1)}
        for item_id, text in server.transcripts.items():
            print(f"\n[smoke] {names[item_id]} ({len(text)} зн., sha1 {hashlib.sha1(text.encode()).hexdigest()[:12]}): {text[:300]}")
        for item_id, reason in server.failed.items():
            print(f"\n[smoke] {names[item_id]} FAILED: {reason}")
    tmp.cleanup()


if __name__ == "__main__":
    main()
