# benchmarking

Benchmarking tools collected in `dev-tools`.

## Included tools

- `vllm-online-benchmark`: Starts a local `vllm serve` process, runs `vllm bench serve`
  across powers-of-two concurrency levels, and stops when output tokens/sec/stream
  falls below a threshold.

## Setup

```bash
uv sync
```

## Usage

Run a quick smoke test:

```bash
uv run vllm-online-benchmark --smoke
```

Run a full sweep:

```bash
uv run vllm-online-benchmark \
  --model cyankiwi/Qwen3.5-4B-AWQ-4bit \
  --input-tokens 8192 \
  --output-tokens 8192 \
  --min-tps-per-stream 15
```

Results are written under `results/`, with a roll-up CSV at
`results/benchmark_summary.csv`.

## Notes

- The current dependency set is tuned for Linux on `aarch64` with CUDA 13 and the
  published `vllm` wheel used in the original benchmark project.
- Add future benchmark runners under `src/benchmarking/` and expose them via
  `[project.scripts]` in `pyproject.toml`.
