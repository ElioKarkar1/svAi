# svAi — SystemVerilog Assistant

svAi is a lightweight Windows desktop workflow app for SystemVerilog:

- edit → lint → build → run → open waves
- Verilator + make build pipeline (MSYS2-based toolchain)
- FST waves + GTKWave launch
- optional AI assist (local Ollama or API)

## Downloads

This repository is intended for **downloading builds**, not as a contributor/dev setup.

Grab the latest installer/zip from **Releases**:
- https://github.com/ElioKarkar1/svAi/releases

## What it uses

- **Tauri** (Rust) for the desktop app shell
- **React + TypeScript** UI
- **Monaco Editor** for code editing
- **Verilator + make** for lint/build/run
- **GTKWave** for waveform viewing (FST)
- **MSYS2 (UCRT64)** toolchain integration on Windows

## Notes

- svAi keeps per-project settings in `.svlab.json` (filelist path, include dirs, defines, verilator args, sim controls).
- The generated waveform file is written under `.svlab/`.
