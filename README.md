# svAi — SystemVerilog Assistant (Tauri)

svAi is a lightweight SystemVerilog workflow app for Windows:

- edit → lint → build → run → open waves
- Verilator + make build pipeline
- FST waves + GTKWave launch

> Status: active development.

---

## Downloads

Grab the latest installer/zip from **Releases**:
- https://github.com/ElioKarkar1/svAi/releases

---

## Prereqs

### Windows toolchain

svAi expects an MSYS2-based Verilator toolchain.

1) Install **MSYS2** (UCRT64)
2) In the **MSYS2 UCRT64** shell:

```bash
pacman -Syu
pacman -S --needed \
  make \
  mingw-w64-ucrt-x86_64-gcc \
  mingw-w64-ucrt-x86_64-make \
  mingw-w64-ucrt-x86_64-verilator \
  mingw-w64-ucrt-x86_64-gtkwave \
  python
```

Verify:

```bash
verilator -V
make --version
python3 --version
gtkwave --version
```

Typical paths (what svAi auto-detects):
- `C:\\msys64\\ucrt64\\bin\\verilator_bin.exe`
- `C:\\msys64\\usr\\bin\\bash.exe`
- `C:\\msys64\\ucrt64\\bin\\gtkwave.exe`

---

## Sample project

There’s a sample SV project in `../svai-sample` (sibling folder in this workspace).

In svAi:
1) Open Folder → pick the project folder
2) Use **Project ▾ → Top module** (svAi will auto-detect testbenches like `tb_*`)
3) Click **Run**
4) Click **Waves** to open the generated `.svlab/waves.fst` in GTKWave

---

## AI Assist (local Ollama)

svAi can run an AI helper locally via **Ollama**.

### Install Ollama

1) Install Ollama for Windows: <https://ollama.com/download>
2) Pull a coding model (recommended default):

```bash
ollama pull qwen2.5-coder:7b
```

3) Sanity check:

```bash
ollama list
```

Ollama usually serves an HTTP API at:
- `http://localhost:11434`

### Use in svAi

1) Open a project folder
2) Open the **AI panel** (right sidebar)
3) Set provider to **Local (Ollama)**
4) Base URL: `http://localhost:11434`
5) Model: `qwen2.5-coder:7b`
6) Type a message and press **Enter** to send (Shift+Enter for newline)

---

## Project config (.svlab.json)

svAi stores project settings in `.svlab.json` in the project root.

Editable via **Project ▾ → Config…**:
- `filelist` (defaults to `files.f`)
- `include_dirs` / `defines`
- `verilator_args`
- sim controls: `max_time`, `trace`, `plusargs`

---

## Notes

- On Windows, svAi runs Verilator/make under MSYS2 `bash -lc` to avoid path/script issues.
- If you ever hit stale build artifacts, use **Build ▾ → Clean Build**.
