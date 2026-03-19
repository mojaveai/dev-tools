from __future__ import annotations

import argparse
import csv
import json
import os
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

from rich.console import Console
from rich.live import Live
from rich.table import Table


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODEL = "cyankiwi/Qwen3.5-4B-AWQ-4bit"
DEFAULT_INPUT_TOKENS = 8192
DEFAULT_OUTPUT_TOKENS = 8192
DEFAULT_MIN_TPS_PER_STREAM = 15.0
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
DEFAULT_RESULTS_DIR = PROJECT_ROOT / "results"
DEFAULT_CSV_PATH = DEFAULT_RESULTS_DIR / "benchmark_summary.csv"
DEFAULT_CUDA_LIB_DIRS = (
    Path("/usr/local/cuda-13.0/targets/sbsa-linux/lib"),
    Path("/usr/local/cuda/targets/sbsa-linux/lib"),
)


@dataclass
class RunRow:
    streams: int
    status: str = "pending"
    requests: int = 0
    completed: int | None = None
    failed: int | None = None
    output_tps: float | None = None
    total_tps: float | None = None
    per_stream_tps: float | None = None
    result_json: str = ""
    note: str = ""


@dataclass
class AppState:
    model: str
    input_tokens: int
    output_tokens: int
    min_tps_per_stream: float
    smoke: bool
    rows: list[RunRow] = field(default_factory=list)
    phase: str = "initializing"
    detail: str = ""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run vLLM online serving benchmarks over powers-of-two stream counts "
            "and stop once output tokens/sec/stream drops below a threshold."
        )
    )
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--input-tokens", type=int, default=DEFAULT_INPUT_TOKENS)
    parser.add_argument("--output-tokens", type=int, default=DEFAULT_OUTPUT_TOKENS)
    parser.add_argument(
        "--min-tps-per-stream",
        type=float,
        default=DEFAULT_MIN_TPS_PER_STREAM,
        help="Stop after a run whose output tokens/sec/stream falls below this value.",
    )
    parser.add_argument(
        "--requests-per-stream",
        type=int,
        default=1,
        help="Number of benchmark requests to schedule per stream for each run.",
    )
    parser.add_argument(
        "--start-streams",
        type=int,
        default=1,
        help="Starting stream count. Must be a positive power of two for the intended sweep.",
    )
    parser.add_argument(
        "--max-streams",
        type=int,
        default=None,
        help="Optional hard cap on stream count.",
    )
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument(
        "--gpu-memory-utilization",
        type=float,
        default=0.85,
        help="Passed through to `vllm serve --gpu-memory-utilization`.",
    )
    parser.add_argument(
        "--results-dir",
        type=Path,
        default=DEFAULT_RESULTS_DIR,
        help="Directory for per-run JSON results and logs.",
    )
    parser.add_argument(
        "--csv-path",
        type=Path,
        default=DEFAULT_CSV_PATH,
        help="CSV file to append summarized benchmark rows to.",
    )
    parser.add_argument(
        "--ready-timeout-sec",
        type=int,
        default=900,
        help="How long to wait for the vLLM server to become ready.",
    )
    parser.add_argument(
        "--poll-interval-sec",
        type=float,
        default=2.0,
        help="Polling interval while waiting on the server or a benchmark subprocess.",
    )
    parser.add_argument(
        "--serve-arg",
        action="append",
        default=[],
        help='Extra argument string to pass to `vllm serve`, for example `--serve-arg "--gpu-memory-utilization 0.9"`.',
    )
    parser.add_argument(
        "--bench-arg",
        action="append",
        default=[],
        help='Extra argument string to pass to `vllm bench serve`, for example `--bench-arg "--tokenizer-mode slow"`.',
    )
    parser.add_argument(
        "--smoke",
        action="store_true",
        help="Fast validation mode: 128 input, 128 output, and at most 2 streams.",
    )
    args = parser.parse_args()

    if args.start_streams < 1:
        parser.error("--start-streams must be >= 1")
    if args.requests_per_stream < 1:
        parser.error("--requests-per-stream must be >= 1")
    if not 0 < args.gpu_memory_utilization <= 1:
        parser.error("--gpu-memory-utilization must be in the range (0, 1]")

    if args.smoke:
        args.input_tokens = 128
        args.output_tokens = 128
        if args.max_streams is None or args.max_streams > 2:
            args.max_streams = 2

    return args


def split_extra_args(raw_values: list[str]) -> list[str]:
    extra_args: list[str] = []
    for value in raw_values:
        extra_args.extend(shlex.split(value))
    return extra_args


def ensure_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def format_float(value: float | None, digits: int = 2) -> str:
    return "-" if value is None else f"{value:.{digits}f}"


def shorten(path: str, keep: int = 42) -> str:
    if len(path) <= keep:
        return path
    return f"...{path[-(keep - 3):]}"


def build_table(state: AppState) -> Table:
    title = "vLLM Smoke Benchmark" if state.smoke else "vLLM Benchmark"
    table = Table(title=title)
    table.add_column("Streams", justify="right")
    table.add_column("Status")
    table.add_column("Reqs", justify="right")
    table.add_column("Completed", justify="right")
    table.add_column("Failed", justify="right")
    table.add_column("Out tok/s", justify="right")
    table.add_column("Tok/s/stream", justify="right")
    table.add_column("Result JSON")
    table.add_column("Note")

    if not state.rows:
        table.add_row("-", state.phase, "-", "-", "-", "-", "-", "-", state.detail or "-")
    else:
        for row in state.rows:
            table.add_row(
                str(row.streams),
                row.status,
                str(row.requests or "-"),
                str(row.completed if row.completed is not None else "-"),
                str(row.failed if row.failed is not None else "-"),
                format_float(row.output_tps),
                format_float(row.per_stream_tps),
                shorten(row.result_json) if row.result_json else "-",
                row.note or "-",
            )

    table.caption = (
        f"Model={state.model} | input={state.input_tokens} | output={state.output_tokens} | "
        f"stop below {state.min_tps_per_stream:.2f} tok/s/stream | phase={state.phase}"
        + (f" | {state.detail}" if state.detail else "")
    )
    return table


def local_bin(binary_name: str) -> Path:
    path = PROJECT_ROOT / ".venv" / "bin" / binary_name
    if not path.exists():
        raise FileNotFoundError(
            f"Expected local venv binary at {path}. Create/sync the venv with uv first."
        )
    return path


def build_child_env() -> dict[str, str]:
    env = os.environ.copy()
    env["PATH"] = f"{PROJECT_ROOT / '.venv' / 'bin'}:{env.get('PATH', '')}"
    cache_root = PROJECT_ROOT / ".cache" / "vllm"
    cache_root.mkdir(parents=True, exist_ok=True)
    env["VLLM_CACHE_ROOT"] = str(cache_root)
    env.setdefault("XDG_CACHE_HOME", str(PROJECT_ROOT / ".cache"))

    python_version = f"python{sys.version_info.major}.{sys.version_info.minor}"
    site_packages = PROJECT_ROOT / ".venv" / "lib" / python_version / "site-packages"
    preferred_lib_dirs = [
        site_packages / "torch" / "lib",
        site_packages / "nvidia" / "cu13" / "lib",
        site_packages / "nvidia" / "cublas" / "lib",
        site_packages / "nvidia" / "cudnn" / "lib",
        site_packages / "nvidia" / "cufft" / "lib",
        site_packages / "nvidia" / "cufile" / "lib",
        site_packages / "nvidia" / "curand" / "lib",
        site_packages / "nvidia" / "cusolver" / "lib",
        site_packages / "nvidia" / "cusparse" / "lib",
        site_packages / "nvidia" / "cusparselt" / "lib",
    ]
    cuda_dirs = [str(path) for path in preferred_lib_dirs if path.exists()]
    cuda_dirs.extend(str(path) for path in DEFAULT_CUDA_LIB_DIRS if path.exists())
    if cuda_dirs:
        existing = env.get("LD_LIBRARY_PATH", "")
        env["LD_LIBRARY_PATH"] = ":".join(cuda_dirs + ([existing] if existing else []))

    return env


def open_url(url: str, timeout: float = 5.0) -> tuple[int, str]:
    request = Request(url, headers={"Accept": "application/json"})
    with urlopen(request, timeout=timeout) as response:
        return response.status, response.read().decode("utf-8", errors="replace")


def server_is_ready(base_url: str) -> bool:
    checks = ("/health", "/v1/models")
    for endpoint in checks:
        try:
            status, _ = open_url(f"{base_url}{endpoint}")
        except URLError:
            return False
        if status != 200:
            return False
    return True


def wait_for_server(
    process: subprocess.Popen[str],
    base_url: str,
    timeout_sec: float,
    poll_interval_sec: float,
    state: AppState,
    live: Live,
) -> None:
    start = time.monotonic()
    while time.monotonic() - start < timeout_sec:
        if process.poll() is not None:
            raise RuntimeError("vLLM server exited before becoming ready.")
        if server_is_ready(base_url):
            state.phase = "server-ready"
            state.detail = f"Server ready at {base_url}"
            live.update(build_table(state))
            return
        elapsed = time.monotonic() - start
        state.phase = "starting-server"
        state.detail = f"Waiting for readiness at {base_url} ({elapsed:.0f}s elapsed)"
        live.update(build_table(state))
        time.sleep(poll_interval_sec)

    raise TimeoutError(f"Timed out waiting for the vLLM server at {base_url}")


def terminate_process(process: subprocess.Popen[str] | None, timeout_sec: float = 20.0) -> None:
    if process is None or process.poll() is not None:
        return

    process.terminate()
    try:
        process.wait(timeout=timeout_sec)
        return
    except subprocess.TimeoutExpired:
        pass

    process.kill()
    process.wait(timeout=timeout_sec)


def stream_counts(start: int, max_streams: int | None):
    current = start
    while True:
        if max_streams is not None and current > max_streams:
            break
        yield current
        current *= 2


def append_csv_row(csv_path: Path, row: dict[str, Any]) -> None:
    ensure_directory(csv_path.parent)
    write_header = not csv_path.exists()
    with csv_path.open("a", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(row.keys()))
        if write_header:
            writer.writeheader()
        writer.writerow(row)


def load_result_json(path: Path) -> dict[str, Any]:
    with path.open() as handle:
        return json.load(handle)


def extract_run_row(streams: int, requests: int, result: dict[str, Any], result_path: Path) -> RunRow:
    output_tps = float(result.get("output_throughput", 0.0))
    total_tps = float(result.get("total_token_throughput", 0.0))
    per_stream_tps = output_tps / streams if streams else 0.0
    return RunRow(
        streams=streams,
        status="done",
        requests=requests,
        completed=int(result.get("completed", 0)),
        failed=int(result.get("failed", 0)),
        output_tps=output_tps,
        total_tps=total_tps,
        per_stream_tps=per_stream_tps,
        result_json=str(result_path),
        note="threshold hit" if per_stream_tps < 0 else "",
    )


def benchmark_command(
    args: argparse.Namespace,
    streams: int,
    requests: int,
    result_dir: Path,
    result_filename: str,
) -> list[str]:
    command = [
        str(local_bin("vllm")),
        "bench",
        "serve",
        "--backend",
        "openai",
        "--model",
        args.model,
        "--host",
        args.host,
        "--port",
        str(args.port),
        "--endpoint",
        "/v1/completions",
        "--dataset-name",
        "random",
        "--random-input-len",
        str(args.input_tokens),
        "--random-output-len",
        str(args.output_tokens),
        "--num-prompts",
        str(requests),
        "--request-rate",
        "inf",
        "--max-concurrency",
        str(streams),
        "--ignore-eos",
        "--seed",
        "0",
        "--save-result",
        "--result-dir",
        str(result_dir),
        "--result-filename",
        result_filename,
        "--disable-tqdm",
    ]
    command.extend(split_extra_args(args.bench_arg))
    return command


def start_server_command(args: argparse.Namespace) -> list[str]:
    command = [
        str(local_bin("vllm")),
        "serve",
        args.model,
        "--host",
        args.host,
        "--port",
        str(args.port),
        "--gpu-memory-utilization",
        str(args.gpu_memory_utilization),
        "--max-model-len",
        str(args.input_tokens + args.output_tokens),
    ]
    command.extend(split_extra_args(args.serve_arg))
    return command


def run_benchmark_subprocess(
    command: list[str],
    env: dict[str, str],
    row: RunRow,
    state: AppState,
    live: Live,
    poll_interval_sec: float,
    stderr_path: Path,
) -> subprocess.CompletedProcess[str]:
    with stderr_path.open("w") as stderr_handle:
        process = subprocess.Popen(
            command,
            cwd=PROJECT_ROOT,
            env=env,
            stdout=subprocess.PIPE,
            stderr=stderr_handle,
            text=True,
        )
        try:
            while True:
                return_code = process.poll()
                if return_code is not None:
                    stdout = process.stdout.read() if process.stdout else ""
                    return subprocess.CompletedProcess(command, return_code, stdout=stdout, stderr="")
                state.phase = "benchmarking"
                state.detail = f"Running {row.streams} stream(s)"
                live.update(build_table(state))
                time.sleep(poll_interval_sec)
        finally:
            if process.stdout:
                process.stdout.close()


def tail_text(path: Path, max_chars: int = 500) -> str:
    if not path.exists():
        return ""
    content = path.read_text(errors="replace")
    return content[-max_chars:]


def csv_record(
    result: dict[str, Any],
    row: RunRow,
    args: argparse.Namespace,
    run_started_at: str,
    server_log_path: Path,
) -> dict[str, Any]:
    return {
        "run_started_at": run_started_at,
        "mode": "smoke" if args.smoke else "full",
        "model": args.model,
        "input_tokens": args.input_tokens,
        "output_tokens": args.output_tokens,
        "streams": row.streams,
        "requests": row.requests,
        "completed": row.completed,
        "failed": row.failed,
        "output_tokens_per_second": format_float(row.output_tps, 6),
        "total_tokens_per_second": format_float(row.total_tps, 6),
        "tokens_per_second_per_stream": format_float(row.per_stream_tps, 6),
        "request_throughput": format_float(float(result.get("request_throughput", 0.0)), 6),
        "mean_ttft_ms": format_float(float(result.get("mean_ttft_ms", 0.0)), 6),
        "mean_e2el_ms": format_float(float(result.get("mean_e2el_ms", 0.0)), 6),
        "result_json": row.result_json,
        "server_log": str(server_log_path),
    }


def recommended_full_command(args: argparse.Namespace) -> str:
    parts = [
        "uv",
        "run",
        "vllm-online-benchmark",
        "--model",
        shlex.quote(args.model),
        "--gpu-memory-utilization",
        str(args.gpu_memory_utilization),
        "--input-tokens",
        str(DEFAULT_INPUT_TOKENS),
        "--output-tokens",
        str(DEFAULT_OUTPUT_TOKENS),
        "--min-tps-per-stream",
        str(DEFAULT_MIN_TPS_PER_STREAM),
    ]
    for raw_arg in args.serve_arg:
        parts.extend(["--serve-arg", shlex.quote(raw_arg)])
    for raw_arg in args.bench_arg:
        parts.extend(["--bench-arg", shlex.quote(raw_arg)])
    return " ".join(parts)


def run() -> int:
    args = parse_args()
    run_started_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    run_stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = args.results_dir / run_stamp
    ensure_directory(run_dir)
    ensure_directory(args.results_dir)
    ensure_directory(args.csv_path.parent)

    console = Console()
    state = AppState(
        model=args.model,
        input_tokens=args.input_tokens,
        output_tokens=args.output_tokens,
        min_tps_per_stream=args.min_tps_per_stream,
        smoke=args.smoke,
    )
    env = build_child_env()
    server_log_path = run_dir / "server.log"
    benchmark_stderr_path = run_dir / "benchmark.stderr.log"
    base_url = f"http://{args.host}:{args.port}"
    server_process: subprocess.Popen[str] | None = None

    try:
        with Live(build_table(state), console=console, refresh_per_second=4) as live:
            state.phase = "starting-server"
            state.detail = "Launching vLLM server"
            live.update(build_table(state))

            with server_log_path.open("w") as server_log_handle:
                server_process = subprocess.Popen(
                    start_server_command(args),
                    cwd=PROJECT_ROOT,
                    env=env,
                    stdout=server_log_handle,
                    stderr=subprocess.STDOUT,
                    text=True,
                )
                wait_for_server(
                    process=server_process,
                    base_url=base_url,
                    timeout_sec=args.ready_timeout_sec,
                    poll_interval_sec=args.poll_interval_sec,
                    state=state,
                    live=live,
                )

            below_threshold = False
            for streams in stream_counts(args.start_streams, args.max_streams):
                requests = streams * args.requests_per_stream
                result_filename = f"bench-streams-{streams}.json"
                result_path = run_dir / result_filename
                row = RunRow(streams=streams, status="running", requests=requests)
                state.rows.append(row)
                live.update(build_table(state))

                command = benchmark_command(
                    args=args,
                    streams=streams,
                    requests=requests,
                    result_dir=run_dir,
                    result_filename=result_filename,
                )
                completed = run_benchmark_subprocess(
                    command=command,
                    env=env,
                    row=row,
                    state=state,
                    live=live,
                    poll_interval_sec=args.poll_interval_sec,
                    stderr_path=benchmark_stderr_path,
                )

                if completed.returncode != 0:
                    row.status = "failed"
                    row.note = tail_text(benchmark_stderr_path) or "benchmark subprocess failed"
                    live.update(build_table(state))
                    raise RuntimeError(
                        f"Benchmark failed for {streams} stream(s). See {benchmark_stderr_path}"
                    )

                if not result_path.exists():
                    row.status = "failed"
                    row.note = "missing result JSON"
                    live.update(build_table(state))
                    raise FileNotFoundError(f"Expected result JSON at {result_path}")

                result = load_result_json(result_path)
                done_row = extract_run_row(streams, requests, result, result_path)
                done_row.note = (
                    "below threshold"
                    if (done_row.per_stream_tps or 0.0) < args.min_tps_per_stream
                    else "ok"
                )
                state.rows[-1] = done_row
                append_csv_row(
                    args.csv_path,
                    csv_record(
                        result=result,
                        row=done_row,
                        args=args,
                        run_started_at=run_started_at,
                        server_log_path=server_log_path,
                    ),
                )

                if (done_row.per_stream_tps or 0.0) < args.min_tps_per_stream:
                    below_threshold = True

                state.phase = "benchmarking"
                state.detail = f"Completed {streams} stream(s)"
                live.update(build_table(state))

                if below_threshold and not (
                    args.smoke and args.max_streams is not None and streams < args.max_streams
                ):
                    break

            state.phase = "complete"
            state.detail = f"CSV updated at {args.csv_path}"
            live.update(build_table(state))

        console.print()
        console.print(f"Run directory: {run_dir}")
        console.print(f"CSV summary: {args.csv_path}")
        if args.smoke:
            console.print("Smoke test passed.")
            console.print("Full benchmark command:")
            console.print(recommended_full_command(args))
        return 0
    except KeyboardInterrupt:
        raise
    finally:
        terminate_process(server_process)


def main() -> None:
    try:
        raise SystemExit(run())
    except KeyboardInterrupt:
        raise SystemExit(130)


if __name__ == "__main__":
    main()
