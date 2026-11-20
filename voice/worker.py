"""
Обработчик голоса jvx-pult: один проход и выход.

Сервер голос не распознаёт. Этот скрипт на компьютере продакта берёт ждущие голосовые,
распознаёт их локальной моделью GigaAM и сдаёт текст обратно. Запускается Планировщиком
раз в несколько минут; вечным процессом не работает.

Порядок прохода (важен: память видеокарты общая с другими программами владельца):
  1. спросить сервер, что ждёт; очередь пуста: выйти, модель не трогая;
  2. взять файл-замок (второй проход при живом первом сразу выходит);
  3. загрузить модель;
  4. по каждому голосовому: claim, скачать, распознать, записать текст рядом, сдать;
  5. выгрузить модель и выйти.

Токен берётся из PULT_TOKEN / PULT_SERVER или из файла настроек утилиты pult (тот же, что у неё)
и никогда не печатается и не пишется в лог.
"""
import sys

sys.dont_write_bytecode = True  # окружение распознавателя чужое: не оставляем в нём __pycache__

import argparse
import contextlib
import datetime
import gc
import http.client
import json
import os
import re
import socket
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

DEFAULT_MODEL = "multilingual_large_ctc"  # как в watch.py
LONGFORM_THRESHOLD_S = 25.0  # граница GigaAM: длиннее модель целиком не берёт
CHUNK_MIN_S = 12.0
CHUNK_MAX_S = 22.0
SAMPLE_RATE = 16000
MAX_AUDIO_MINUTES = 180
MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024
MAX_TEXT_CHARS = 100000  # предел сервера для transcript
ID_RE = re.compile(r"^[0-9A-Za-z]{26}$")
KNOWN_EXT = {"ogg", "oga", "opus", "mp3", "m4a", "wav"}
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "[::1]"}
LOCK_MAX_AGE_S = 6 * 3600  # живой pid старше этого срока считаем переиспользованным
WORK_LEFTOVER_DAYS = 2

EXIT_OK = 0
EXIT_CONFIG = 2
EXIT_NETWORK = 3
EXIT_MODEL = 5


class ConfigError(Exception):
    pass


class NetworkError(Exception):
    """Текст строится из кода сбоя, а не из текста исключения: в тексте исключения бывает адрес с секретами."""


class ApiError(Exception):
    def __init__(self, status, message=""):
        super().__init__(f"HTTP {status}")
        self.status = status
        self.message = message


class PublicError(Exception):
    """Причина сбоя, которую можно отправить на сервер: фиксированная фраза, без путей и чужого текста."""


# ----------------------------------------------------------------------------------------------
# Настройки и адрес сервера
# ----------------------------------------------------------------------------------------------


def config_file_path(env):
    if env.get("PULT_CONFIG"):
        return Path(env["PULT_CONFIG"])
    if os.name == "nt":
        base = env.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / "pult" / "config.json"
    return Path.home() / ".config" / "pult" / "config.json"


def read_config_file(env):
    path = config_file_path(env)
    try:
        raw = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return {}
    except OSError:
        raise ConfigError("Не удалось прочитать файл настроек pult.")
    try:
        data = json.loads(raw)
    except ValueError:
        data = None
    if not isinstance(data, dict):
        # содержимое не печатаем: в файле токен
        raise ConfigError("Файл настроек pult повреждён: выполните pult login заново.")
    return data


def normalize_server(raw):
    """Адрес сервера без хвоста /api/v1. Открытый http только для localhost, 127.0.0.1, [::1] и *.test."""
    try:
        url = urllib.parse.urlsplit(str(raw or "").strip())
        host = (url.hostname or "").lower()
        port = url.port
    except ValueError:
        raise ConfigError("Адрес сервера не понят: нужен вид https://команда.пример.рф")
    if url.scheme not in ("https", "http") or not host:
        raise ConfigError("Адрес сервера должен начинаться с https://")
    if url.username or url.password or url.query or url.fragment:
        raise ConfigError("Адрес сервера не должен содержать логин, параметры или якорь.")
    shown_host = f"[{host}]" if ":" in host else host
    if url.scheme == "http" and shown_host not in LOOPBACK_HOSTS and not host.endswith(".test"):
        raise ConfigError(
            f"Отказ: {shown_host} по http. Токен не должен уходить открытым текстом; используйте https:// "
            "(http допустим только для localhost, 127.0.0.1 и *.test)."
        )
    path = re.sub(r"/api/v1$", "", url.path.rstrip("/"))
    netloc = shown_host + (f":{port}" if port else "")
    return f"{url.scheme}://{netloc}{path}"


def resolve_settings(env):
    need_file = not env.get("PULT_TOKEN") or not env.get("PULT_SERVER")
    file = read_config_file(env) if need_file else {}
    server = env.get("PULT_SERVER") or file.get("server")
    token = env.get("PULT_TOKEN") or file.get("token")
    if not server:
        raise ConfigError("Сервер не задан: pult login <токен> --server <адрес> или PULT_SERVER.")
    server = normalize_server(server)
    if not isinstance(token, str) or token.strip() == "":
        raise ConfigError("Токена нет: pult login <токен> или PULT_TOKEN.")
    return server, token.strip()


# ----------------------------------------------------------------------------------------------
# HTTP
# ----------------------------------------------------------------------------------------------


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # токен не должен уйти туда, куда сервер перенаправил


class Api:
    """Токен живёт только здесь и попадает только в заголовок Authorization."""

    def __init__(self, server, token, timeout=30.0):
        self.server = server
        self._token = token
        self.timeout = timeout
        host = (urllib.parse.urlsplit(server).hostname or "").lower()
        handlers = [_NoRedirect()]
        if host in {"localhost", "127.0.0.1", "::1"} or host.endswith(".test"):
            handlers.append(urllib.request.ProxyHandler({}))
        self._opener = urllib.request.build_opener(*handlers)

    def _scrub(self, text):
        return text.replace(self._token, "[токен скрыт]")

    def _open(self, method, path, body=None, query=None, accept="application/json"):
        url = f"{self.server}/api/v1/{path}"
        if query:
            url += "?" + urllib.parse.urlencode(query)
        headers = {
            "Accept": accept,
            "User-Agent": "pult-voice/0.1",
            "Authorization": f"Bearer {self._token}",
        }
        data = None
        if method == "POST":
            data = json.dumps(body if body is not None else {}, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            return self._opener.open(req, timeout=self.timeout)
        except urllib.error.HTTPError as e:
            raw = b""
            with contextlib.suppress(Exception):
                raw = e.read(65536)
            if 300 <= e.code < 400:
                raise NetworkError(
                    f"Сервер ответил переадресацией (HTTP {e.code}): адрес сервера должен быть конечным."
                )
            raise ApiError(e.code, self._server_message(raw))
        except urllib.error.URLError as e:
            raise self._network_error(e.reason)
        except (OSError, http.client.HTTPException) as e:
            raise self._network_error(e)

    def _server_message(self, raw):
        try:
            message = json.loads(raw.decode("utf-8", "replace")).get("message", "")
        except Exception:
            return ""
        return self._scrub(str(message))[:200] if isinstance(message, str) else ""

    def _network_error(self, reason):
        if isinstance(reason, ssl.SSLError):
            why = "сертификат сервера не принят"
        elif isinstance(reason, (socket.timeout, TimeoutError)):
            why = "сервер не ответил вовремя"
        elif isinstance(reason, ConnectionRefusedError):
            why = "соединение отклонено"
        elif isinstance(reason, ConnectionResetError):
            why = "соединение оборвано"
        elif isinstance(reason, socket.gaierror):
            why = "имя сервера не найдено"
        else:
            why = "сбой соединения"
        return NetworkError(f"Нет связи с сервером: {why}.")

    def json(self, method, path, body=None, query=None):
        for attempt in (1, 2):
            try:
                with self._open(method, path, body, query) as resp:
                    raw = resp.read(8 * 1024 * 1024)
                break
            except ApiError as e:
                if e.status == 429 and attempt == 1:
                    time.sleep(1)  # 429 отклонён до выполнения: повтор безопасен
                    continue
                raise
            except (OSError, http.client.HTTPException) as e:
                raise self._network_error(e)
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            raise ApiError(200, "ответ сервера не разобран")

    def download(self, path, dest):
        """Файл в dest частями; обрыв или недокачка: NetworkError, и dest не остаётся."""
        written = 0
        try:
            with self._open("GET", path, accept="*/*") as resp, open(dest, "wb") as out:
                expected = resp.headers.get("Content-Length")
                while True:
                    chunk = resp.read(1024 * 256)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > MAX_DOWNLOAD_BYTES:
                        raise PublicError("Файл больше допустимого размера.")
                    out.write(chunk)
            if expected is not None and expected.isdigit() and int(expected) != written:
                raise NetworkError("Нет связи с сервером: файл скачан не полностью.")
        except (OSError, http.client.HTTPException) as e:
            with contextlib.suppress(OSError):
                os.remove(dest)
            raise self._network_error(e)
        except BaseException:
            with contextlib.suppress(OSError):
                os.remove(dest)
            raise
        return written


# ----------------------------------------------------------------------------------------------
# Журнал: дата, id, длительность; текст расшифровки не пишется никогда
# ----------------------------------------------------------------------------------------------


class Log:
    def __init__(self, log_dir, now=time.time):
        self.dir = Path(log_dir)
        self.now = now

    def line(self, level, message):
        stamp = datetime.datetime.fromtimestamp(self.now())
        text = f"{stamp:%Y-%m-%d %H:%M:%S} {level} {message}"
        print(text, flush=True)
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            with open(self.dir / f"voice-{stamp:%Y-%m-%d}.log", "a", encoding="utf-8") as f:
                f.write(text + "\n")
        except OSError:
            pass  # журнал не должен ронять проход

    def info(self, message):
        self.line("INFO", message)

    def error(self, message):
        self.line("ERROR", message)


# ----------------------------------------------------------------------------------------------
# Замок
# ----------------------------------------------------------------------------------------------


def pid_alive(pid):
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        k32.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return ctypes.get_last_error() == 5  # доступ запрещён: процесс есть, чужой
        try:
            code = wintypes.DWORD()
            return bool(k32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259  # STILL_ACTIVE
        finally:
            k32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class Lock:
    def __init__(self, path, now=time.time):
        self.path = Path(path)
        self.now = now
        self.held = False

    def _holder_alive(self):
        try:
            mtime = self.path.stat().st_mtime
            raw = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return False
        except UnicodeDecodeError:
            raw = ""  # битый замок: разбираем как пустой
        except OSError:
            return True
        try:
            info = json.loads(raw)
            pid, started = int(info["pid"]), float(info["started"])
        except (ValueError, KeyError, TypeError):
            # Пустой или битый замок: возможно, его как раз пишут. Снимаем, только если давний.
            return self.now() - mtime < 60
        if self.now() - started > LOCK_MAX_AGE_S:
            return False
        return pid_alive(pid)

    def acquire(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(3):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                if self._holder_alive():
                    return False
                with contextlib.suppress(FileNotFoundError):
                    os.remove(self.path)
                continue
            except OSError:
                return False
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"pid": os.getpid(), "started": self.now()}, f)
            self.held = True
            return True
        return False

    def release(self):
        if not self.held:
            return
        self.held = False
        with contextlib.suppress(OSError, ValueError, KeyError):
            if json.loads(self.path.read_text(encoding="utf-8"))["pid"] == os.getpid():
                os.remove(self.path)


# ----------------------------------------------------------------------------------------------
# Каталоги и файлы
# ----------------------------------------------------------------------------------------------


@dataclass
class Dirs:
    root: Path
    work: Path
    done: Path
    failed: Path
    logs: Path
    lock: Path

    @classmethod
    def make(cls, root):
        root = Path(root)
        return cls(root, root / "work", root / "done", root / "failed", root / "logs", root / "worker.lock")

    def create(self):
        for d in (self.work, self.done, self.failed, self.logs):
            d.mkdir(parents=True, exist_ok=True)


def atomic_write(path, data):
    """Временный файл рядом и замена: читатель не увидит половину текста."""
    path = Path(path)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.part")
    try:
        with open(tmp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.remove(tmp)
        raise


def move_into(src, dest_dir):
    """Переносит файл в каталог с обновлением времени: срок хранения считается от обработки."""
    dest = Path(dest_dir) / Path(src).name
    os.replace(src, dest)
    os.utime(dest, None)
    return dest


def cleanup(dirs, keep_days, now):
    """Успешно обработанное удаляется через keep_days, брошенные полуфабрикаты через пару дней. failed/ не трогаем."""
    removed = 0
    for folder, days in ((dirs.done, keep_days), (dirs.work, WORK_LEFTOVER_DAYS)):
        cutoff = now - days * 86400
        try:
            entries = list(os.scandir(folder))
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_file(follow_symlinks=False) and entry.stat().st_mtime < cutoff:
                    os.remove(entry.path)
                    removed += 1
            except OSError:
                pass
    return removed


# ----------------------------------------------------------------------------------------------
# Распознавание
# ----------------------------------------------------------------------------------------------


@dataclass
class Recognition:
    text: str
    mode: str
    audio_seconds: float


def plan_chunks(db, min_chunk=CHUNK_MIN_S, max_chunk=CHUNK_MAX_S, hop_s=0.01, total_samples=None):
    """
    Нарезка длинной записи по паузам; db: энергия кадров по 10 мс. Возвращает [(от, до)] в секундах.

    Идея longform_local.py: в окне [min, max] от текущей позиции режем посреди самой длинной паузы.
    Если паузы нет (говорят без вдоха), режем в самом тихом месте окна, а не вслепую. Куски тишины
    выбрасываются. Перекрытия нет: текст из кусков склеивается без слияния дублей.
    """
    n = len(db)
    if n == 0:
        return []
    srt = sorted(db)
    floor = srt[int(0.2 * (n - 1))]
    # Порог паузы: пол шума + 9 дБ, но не выше медианы: в записи без тихих мест иначе вся запись «пауза».
    thr = min(floor + 9.0, srt[n // 2])
    sil_min = 30  # 300 мс тишины считаем паузой

    runs = []
    start = None
    for i, v in enumerate(db):
        if v < thr:
            if start is None:
                start = i
        elif start is not None:
            if i - start >= sil_min:
                runs.append((start, i))
            start = None
    if start is not None and n - start >= sil_min:
        runs.append((start, n))
    mids = sorted(((a + b) // 2, b - a) for a, b in runs)

    # префиксные суммы для поиска самого тихого окна 200 мс
    pref = [0.0]
    for v in db:
        pref.append(pref[-1] + v)
    win = 20

    total = n if total_samples is None else total_samples / (hop_s * SAMPLE_RATE)
    max_f, min_f = int(max_chunk / hop_s), int(min_chunk / hop_s)

    bounds, pos, j = [], 0, 0
    while pos < total:
        if total - pos <= max_f:
            bounds.append((pos, total))
            break
        lo, hi = pos + min_f, pos + max_f
        while j < len(mids) and mids[j][0] < lo:
            j += 1
        best, best_len = None, -1
        k = j
        while k < len(mids) and mids[k][0] <= hi:
            if mids[k][1] > best_len:
                best, best_len = mids[k][0], mids[k][1]
            k += 1
        if best is None:
            best_cost, best = None, hi
            for c in range(lo, hi - win + 1):
                if c + win > n:
                    break
                cost = pref[c + win] - pref[c]
                if best_cost is None or cost < best_cost:
                    best_cost, best = cost, c + win // 2
        bounds.append((pos, best))
        pos = best

    kept = []
    for a, b in bounds:
        a_i, b_i = int(a), int(b)
        seg = sorted(db[a_i : max(a_i + 1, b_i)])
        # Тишина: самый громкий кадр куска не выше шума записи и вообще тихий. Абсолютный порог
        # нужен, чтобы шумная запись без пауз не была принята за пустую целиком.
        if seg and seg[int(0.95 * (len(seg) - 1))] < min(floor + 6.0, -40.0):
            continue
        kept.append((a * hop_s, b * hop_s))
    return kept


class GigaamRecognizer:
    """
    Модель GigaAM из кеша ~/.cache/gigaam (скачивания здесь нет: если файла нет, gigaam пойдёт качать,
    и это решение владельца, а не наше). Короткие записи: model.transcribe, как в watch.py. Длинные:
    transcribe_longform требует pyannote и HF_TOKEN, которых в окружении нет, поэтому режем сами.
    """

    def __init__(self, model_name, device=None, workdir=None):
        import torch  # тяжёлые импорты только здесь: пустая очередь их не платит

        import gigaam

        self._torch = torch
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.workdir = Path(workdir)
        self.model = gigaam.load_model(model_name, device=self.device)

    def describe(self):
        t = self._torch
        if self.device.startswith("cuda") and t.cuda.is_available():
            return f"cuda ({t.cuda.get_device_name(0)})"
        return self.device

    def transcribe(self, path):
        from gigaam.preprocess import load_audio

        try:
            wav = load_audio(str(path))
        except Exception:
            raise PublicError("Не удалось прочитать аудио: файл повреждён или это не аудио.")
        seconds = wav.numel() / SAMPLE_RATE
        if seconds < 0.2:
            raise PublicError("Запись пустая или короче 0,2 секунды.")
        if seconds > MAX_AUDIO_MINUTES * 60:
            raise PublicError(f"Запись длиннее {MAX_AUDIO_MINUTES} минут: не берём.")

        if seconds <= LONGFORM_THRESHOLD_S:
            return Recognition(self.model.transcribe(str(path)).text.strip(), "short", seconds)
        return Recognition(self._longform(wav), "chunked", seconds)

    def _frame_db(self, wav):
        t = self._torch
        out = []
        block = SAMPLE_RATE * 60
        pos = 0
        # блоками по минуте: на час записи полный unfold съел бы больше полугигабайта
        while pos + 400 <= wav.numel():
            end = min(wav.numel(), pos + block + 400 - 160)
            frames = wav[pos:end].unfold(0, 400, 160)
            rms = frames.pow(2).mean(dim=1).clamp_min(1e-12).sqrt()
            out.extend((20.0 * t.log10(rms)).tolist())
            pos += frames.shape[0] * 160
        return out

    def _longform(self, wav):
        import soundfile as sf

        t = self._torch
        db = self._frame_db(wav)
        chunks = plan_chunks(db, total_samples=wav.numel())
        if not chunks:
            return ""
        self.workdir.mkdir(parents=True, exist_ok=True)
        parts = []
        for i, (a, b) in enumerate(chunks):
            piece = wav[int(a * SAMPLE_RATE) : int(b * SAMPLE_RATE)]
            pcm = (piece * 32768.0).round().clamp(-32768, 32767).to(t.int16).numpy()
            chunk_path = self.workdir / f"chunk-{os.getpid()}-{i}.wav"
            try:
                sf.write(str(chunk_path), pcm, SAMPLE_RATE, subtype="PCM_16")
                text = self.model.transcribe(str(chunk_path)).text.strip()
            finally:
                with contextlib.suppress(OSError):
                    os.remove(chunk_path)
            if text:
                parts.append(text)
        return " ".join(parts)

    def close(self):
        self.model = None
        gc.collect()
        with contextlib.suppress(Exception):
            if self._torch.cuda.is_available():
                self._torch.cuda.empty_cache()


def public_reason(exc):
    """Причина для сервера: либо наша фраза, либо только класс ошибки. Текст исключения и пути не уходят."""
    if isinstance(exc, PublicError):
        return str(exc)
    name = type(exc).__name__
    if "OutOfMemory" in name:
        return "Не хватило памяти видеокарты при распознавании."
    return f"Сбой распознавания ({name})."


# ----------------------------------------------------------------------------------------------
# Проход
# ----------------------------------------------------------------------------------------------


def lower_priority():
    if os.name != "nt":
        return
    with contextlib.suppress(Exception):
        import ctypes

        k32 = ctypes.WinDLL("kernel32")
        k32.GetCurrentProcess.restype = ctypes.c_void_p
        k32.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        k32.SetPriorityClass(k32.GetCurrentProcess(), 0x4000)  # BELOW_NORMAL


def default_data_dir(env):
    if env.get("PULT_VOICE_DATA_DIR"):
        return env["PULT_VOICE_DATA_DIR"]
    if os.name == "nt":
        base = env.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return str(Path(base) / "jvx-pult" / "voice")
    return str(Path.home() / ".local" / "share" / "jvx-pult" / "voice")


def parse_args(argv, env):
    p = argparse.ArgumentParser(prog="worker.py", description="Обработчик голоса jvx-pult: один проход.")
    p.add_argument("--data-dir", default=default_data_dir(env), help="каталог данных (по умолчанию %%LOCALAPPDATA%%\\jvx-pult\\voice)")
    p.add_argument("--keep-days", type=float, default=float(env.get("PULT_VOICE_KEEP_DAYS") or 30), help="сколько дней хранить обработанное (30)")
    p.add_argument("--limit", type=int, default=25, help="сколько голосовых брать за проход (25)")
    p.add_argument("--model", default=env.get("GIGAAM_MODEL") or DEFAULT_MODEL)
    p.add_argument("--timeout", type=float, default=30.0, help="таймаут запроса к серверу, секунд")
    return p.parse_args(argv)


def process_item(api, recognizer, item, dirs, log):
    """Возвращает 'done' | 'failed' | 'skipped'. NetworkError не ловит: проход обрывается целиком."""
    vid = item.get("id") if isinstance(item, dict) else None
    if not isinstance(vid, str) or not ID_RE.match(vid):
        log.error("в очереди элемент без понятного id: пропущен")
        return "skipped"
    ext = str(item.get("ext") or "").lower()
    ext = ext if ext in KNOWN_EXT else "bin"

    try:
        api.json("POST", f"voice/{vid}/claim")
    except ApiError as e:
        log.info(f"id={vid} не взят (HTTP {e.status}): {'уже у другого обработчика' if e.status == 409 else e.message or 'отказ'}")
        return "skipped"

    audio = dirs.work / f"{vid}.{ext}"
    text_path = dirs.work / f"{vid}.txt"

    def fail(reason, keep_audio=True):
        # файл, не прошедший распознавание, остаётся для разбора
        if keep_audio and audio.exists():
            move_into(audio, dirs.failed)
        if text_path.exists():
            move_into(text_path, dirs.failed)
        atomic_write(dirs.failed / f"{vid}.reason.txt", reason.encode("utf-8"))
        try:
            api.json("POST", f"voice/{vid}/failed", {"reason": reason})
        except ApiError as e:
            log.error(f"id={vid} сбой не принят сервером (HTTP {e.status})")
        log.info(f"id={vid} FAILED: {reason}")
        return "failed"

    try:
        api.download(f"voice/{vid}/file", audio)
    except ApiError as e:
        if e.status == 404:
            return fail("Файл этого голосового недоступен на сервере.", keep_audio=False)
        log.error(f"id={vid} файл не отдан (HTTP {e.status}): пропущен")
        return "skipped"
    except PublicError as e:
        return fail(str(e), keep_audio=False)

    started = time.perf_counter()
    try:
        result = recognizer.transcribe(audio)
    except Exception as e:
        log.error(f"id={vid} сбой распознавания: {type(e).__name__}")
        return fail(public_reason(e))
    took = time.perf_counter() - started

    text = result.text.strip()
    if not text:
        return fail("Распознавание не дало текста: речи не найдено или запись пустая.")
    if len(text) > MAX_TEXT_CHARS:
        atomic_write(text_path, text.encode("utf-8"))
        return fail(f"Расшифровка длиннее {MAX_TEXT_CHARS} символов: сервер её не примет.")

    atomic_write(text_path, text.encode("utf-8"))
    try:
        api.json("POST", f"voice/{vid}/transcript", {"text": text})
    except ApiError as e:
        # 409: наш захват протух, строка вернулась в очередь; файлы остаются в work/ до следующего прохода
        log.error(f"id={vid} расшифровка не принята сервером (HTTP {e.status})")
        return "skipped"
    log.info(f"id={vid} OK mode={result.mode} audio={result.audio_seconds:.1f}s asr={took:.1f}s chars={len(text)}")
    move_into(audio, dirs.done)
    move_into(text_path, dirs.done)
    return "done"


def run(argv=None, env=None, recognizer_factory=None, now=time.time):
    """
    recognizer_factory(model_name, workdir) -> объект с transcribe(path) и close(); по умолчанию настоящий GigaAM.
    Вызывается только когда очередь не пуста и замок взят.
    """
    env = dict(os.environ if env is None else env)
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(Exception):
            stream.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args(argv, env)
    if args.keep_days < 0 or args.limit < 1:
        print("Неверные параметры: --keep-days >= 0, --limit >= 1.")
        return EXIT_CONFIG

    dirs = Dirs.make(args.data_dir)
    try:
        dirs.create()
    except OSError:
        print("Не удалось создать каталог данных.")
        return EXIT_CONFIG
    log = Log(dirs.logs, now)

    try:
        server, token = resolve_settings(env)
    except ConfigError as e:
        log.error(str(e))
        return EXIT_CONFIG
    api = Api(server, token, args.timeout)

    removed = cleanup(dirs, args.keep_days, now())
    if removed:
        log.info(f"удалено устаревших файлов: {removed}")

    try:
        pending = api.json("GET", "voice/pending", query={"limit": args.limit})
        items = pending.get("items") if isinstance(pending, dict) else None
        if not isinstance(items, list):
            raise ApiError(200, "ответ сервера не разобран")
    except NetworkError as e:
        log.error(str(e))
        return EXIT_NETWORK
    except ApiError as e:
        hint = {401: "токен не принят", 403: "у токена нет права на голос (нужен product или adjutant)"}.get(e.status, e.message or "отказ")
        log.error(f"Очередь не получена: HTTP {e.status}, {hint}.")
        # 401 и 403 сами не пройдут: это не «нет связи», а настройка токена.
        return EXIT_CONFIG if e.status in (401, 403) else EXIT_NETWORK

    if not items:
        return EXIT_OK  # модель не трогаем: память видеокарты общая с другими программами

    lock = Lock(dirs.lock, now)
    if not lock.acquire():
        log.info("уже работает другой проход (замок жив): выхожу")
        return EXIT_OK

    recognizer = None
    counts = {"done": 0, "failed": 0, "skipped": 0}
    code = EXIT_OK
    try:
        lower_priority()
        factory = recognizer_factory or (lambda model, workdir: GigaamRecognizer(model, workdir=workdir))
        loaded = time.perf_counter()
        try:
            recognizer = factory(args.model, dirs.work)
        except Exception as e:
            # ничего ещё не взято: ничего и не теряется, следующий проход попробует снова
            log.error(f"Модель не загрузилась: {type(e).__name__}. Видеокарта занята или модели нет в кеше.")
            return EXIT_MODEL
        where = recognizer.describe() if hasattr(recognizer, "describe") else "?"
        log.info(f"в очереди {len(items)}; модель {args.model} загружена за {time.perf_counter() - loaded:.1f}s, устройство {where}")

        for item in items:
            counts[process_item(api, recognizer, item, dirs, log)] += 1
    except NetworkError as e:
        # захват протухнет на сервере через 30 минут, и строка вернётся в очередь
        log.error(f"{e} Проход прерван; недоделанное вернётся в очередь само.")
        code = EXIT_NETWORK
    finally:
        if recognizer is not None:
            with contextlib.suppress(Exception):
                recognizer.close()
        lock.release()
        gc.collect()

    log.info(f"проход завершён: готово {counts['done']}, сбоев {counts['failed']}, пропущено {counts['skipped']}")
    return code


def main():
    try:
        sys.exit(run())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as e:
        # только класс: в тексте и трассировке неожиданного исключения может оказаться что угодно
        print(f"Неожиданный сбой: {type(e).__name__}", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
