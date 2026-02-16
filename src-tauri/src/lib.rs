use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SvlabConfig {
    #[serde(default)]
    top: String,
    #[serde(default)]
    filelist: String,
    #[serde(default)]
    include_dirs: Vec<String>,
    #[serde(default)]
    defines: Vec<String>,
    #[serde(default)]
    verilator_args: Vec<String>,

    // Sim controls
    #[serde(default)]
    max_time: u64,
    #[serde(default)]
    trace: bool,
    #[serde(default)]
    plusargs: Vec<String>,
}

impl Default for SvlabConfig {
    fn default() -> Self {
        Self {
            top: "".to_string(),
            filelist: "files.f".to_string(),
            include_dirs: vec![],
            defines: vec![],
            verilator_args: vec!["--sv".to_string(), "-Wall".to_string(), "--timing".to_string()],
            max_time: 200000,
            trace: true,
            plusargs: vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FsNode {
    path: String, // relative to root
    name: String,
    is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ToolchainStatus {
    verilator_path: String,
    ok: bool,
    version: String,
    error: String,

    #[serde(default)]
    make_path: String,
    #[serde(default)]
    make_ok: bool,
    #[serde(default)]
    make_version: String,
    #[serde(default)]
    make_error: String,

    #[serde(default)]
    gtkwave_path: String,
    #[serde(default)]
    gtkwave_ok: bool,
    #[serde(default)]
    gtkwave_version: String,
    #[serde(default)]
    gtkwave_error: String,

    #[serde(default)]
    bash_path: String,
    #[serde(default)]
    bash_ok: bool,
    #[serde(default)]
    bash_error: String,

    #[serde(default)]
    python_path: String,
    #[serde(default)]
    python_ok: bool,
    #[serde(default)]
    python_version: String,
    #[serde(default)]
    python_error: String,

    #[serde(default)]
    gpp_path: String,
    #[serde(default)]
    gpp_ok: bool,
    #[serde(default)]
    gpp_version: String,
    #[serde(default)]
    gpp_error: String,
}

fn canonicalize_lossy(p: &Path) -> Result<String, String> {
    p.canonicalize()
        .map_err(|e| format!("Failed to canonicalize path: {e}"))
        .map(|x| x.to_string_lossy().to_string())
}

fn ensure_within_root(root: &Path, p: &Path) -> Result<(), String> {
    let canon_root = root
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize root: {e}"))?;
    let canon = p
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize path: {e}"))?;
    if !canon.starts_with(&canon_root) {
        return Err("Refusing to access path outside project root".to_string());
    }
    Ok(())
}

fn read_json<T: for<'a> Deserialize<'a>>(path: &Path) -> Result<T, String> {
    let s = fs::read_to_string(path).map_err(|e| format!("Failed to read file: {e}"))?;
    serde_json::from_str(&s).map_err(|e| format!("Failed to parse JSON: {e}"))
}

fn write_json<T: Serialize>(path: &Path, v: &T) -> Result<(), String> {
    let s = serde_json::to_string_pretty(v).map_err(|e| format!("Failed to serialize JSON: {e}"))?;
    fs::write(path, s).map_err(|e| format!("Failed to write file: {e}"))
}

fn verilator_candidates() -> Vec<String> {
    let mut c = vec!["verilator".to_string()];
    if cfg!(windows) {
        c.push("C:\\msys64\\ucrt64\\bin\\verilator_bin.exe".to_string());
        c.push("C:\\msys64\\mingw64\\bin\\verilator_bin.exe".to_string());
        c.push("C:\\msys64\\ucrt64\\bin\\verilator".to_string());
    }
    c
}

fn run_cmd_capture(mut cmd: Command) -> Result<(i32, String), String> {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let out = cmd.output().map_err(|e| format!("Failed to run command: {e}"))?;
    let code = out.status.code().unwrap_or(1);

    let mut s = String::new();
    if !out.stdout.is_empty() {
        s.push_str(&String::from_utf8_lossy(&out.stdout));
    }
    if !out.stderr.is_empty() {
        if !s.ends_with('\n') && !s.is_empty() {
            s.push('\n');
        }
        s.push_str(&String::from_utf8_lossy(&out.stderr));
    }

    Ok((code, s.trim().to_string()))
}

fn is_msys2_path(p: &str) -> bool {
    let l = p.to_lowercase();
    l.contains("\\msys64\\") || l.contains("/msys64/")
}

fn msys2_bash_path() -> String {
    "C:\\msys64\\usr\\bin\\bash.exe".to_string()
}

fn run_msys2_bash(root: &Path, script: &str) -> Result<(i32, String), String> {
    let bash = msys2_bash_path();
    if !PathBuf::from(&bash).exists() {
        return Err("MSYS2 bash.exe not found at C:\\msys64\\usr\\bin\\bash.exe".to_string());
    }

    // -l for login env, -c for command
    let mut cmd = Command::new(&bash);
    cmd.current_dir(root);
    cmd.arg("-lc");
    cmd.arg(script);

    // Ensure MSYS knows we're in UCRT64 context.
    cmd.env("CHERE_INVOKING", "1");
    cmd.env("MSYSTEM", "UCRT64");

    // Ensure core utils + toolchain resolve.
    let cur_path = std::env::var("PATH").unwrap_or_default();
    let prefix = "C:\\msys64\\usr\\bin;C:\\msys64\\ucrt64\\bin;";
    cmd.env("PATH", format!("{}{}", prefix, cur_path));

    run_cmd_capture(cmd)
}

fn make_candidates() -> Vec<String> {
    let mut c = vec!["make".to_string()];
    if cfg!(windows) {
        c.insert(0, "C:\\msys64\\usr\\bin\\make.exe".to_string());
        c.insert(0, "C:\\msys64\\ucrt64\\bin\\make.exe".to_string());
        c.insert(0, "C:\\msys64\\mingw64\\bin\\make.exe".to_string());
    }
    c
}

fn detect_make() -> (String, bool, String, String) {
    for cand in make_candidates() {
        let path = cand.clone();
        let mut cmd = Command::new(&path);
        cmd.arg("--version");
        if let Ok((code, out)) = run_cmd_capture(cmd) {
            if code == 0 {
                return (path, true, out.lines().next().unwrap_or("").to_string(), "".to_string());
            }
        }
    }
    ("".to_string(), false, "".to_string(), "make not found".to_string())
}

fn gtkwave_candidates() -> Vec<String> {
    let mut c = vec!["gtkwave".to_string()];
    if cfg!(windows) {
        c.insert(0, "C:\\msys64\\ucrt64\\bin\\gtkwave.exe".to_string());
        c.insert(0, "C:\\msys64\\mingw64\\bin\\gtkwave.exe".to_string());
    }
    c
}

fn detect_gtkwave() -> (String, bool, String, String) {
    for cand in gtkwave_candidates() {
        let path = cand.clone();
        let mut cmd = Command::new(&path);
        cmd.arg("--version");
        if let Ok((code, out)) = run_cmd_capture(cmd) {
            if code == 0 {
                // gtkwave prints multi-line version; keep first non-empty line
                let ver = out.lines().find(|l| !l.trim().is_empty()).unwrap_or("").to_string();
                return (path, true, ver, "".to_string());
            }
        }
    }
    ("".to_string(), false, "".to_string(), "gtkwave not found".to_string())
}

fn detect_bash() -> (String, bool, String) {
    if cfg!(windows) {
        let p = PathBuf::from("C:\\msys64\\usr\\bin\\bash.exe");
        if p.exists() {
            return (p.to_string_lossy().to_string(), true, "".to_string());
        }
        return ("".to_string(), false, "MSYS2 bash.exe not found at C:\\msys64\\usr\\bin\\bash.exe".to_string());
    }
    // non-windows: assume bash exists
    ("bash".to_string(), true, "".to_string())
}

fn detect_python3() -> (String, bool, String, String) {
    let cands = if cfg!(windows) {
        vec![
            "C:\\msys64\\ucrt64\\bin\\python3.exe".to_string(),
            "python3".to_string(),
            "python".to_string(),
        ]
    } else {
        vec!["python3".to_string(), "python".to_string()]
    };

    for cand in cands {
        let mut cmd = Command::new(&cand);
        cmd.arg("--version");
        if let Ok((code, out)) = run_cmd_capture(cmd) {
            if code == 0 {
                let ver = out.lines().find(|l| !l.trim().is_empty()).unwrap_or("").to_string();
                return (cand, true, ver, "".to_string());
            }
        }
    }

    ("".to_string(), false, "".to_string(), "python3 not found".to_string())
}

fn detect_gpp() -> (String, bool, String, String) {
    let cands = if cfg!(windows) {
        vec![
            "C:\\msys64\\ucrt64\\bin\\g++.exe".to_string(),
            "g++".to_string(),
        ]
    } else {
        vec!["g++".to_string()]
    };

    for cand in cands {
        let mut cmd = Command::new(&cand);
        cmd.arg("--version");
        if let Ok((code, out)) = run_cmd_capture(cmd) {
            if code == 0 {
                let ver = out.lines().find(|l| !l.trim().is_empty()).unwrap_or("").to_string();
                return (cand, true, ver, "".to_string());
            }
        }
    }

    ("".to_string(), false, "".to_string(), "g++ not found".to_string())
}

fn detect_verilator() -> ToolchainStatus {
    let (make_path, make_ok, make_version, make_error) = detect_make();
    let (gtkwave_path, gtkwave_ok, gtkwave_version, gtkwave_error) = detect_gtkwave();
    let (bash_path, bash_ok, bash_error) = detect_bash();
    let (python_path, python_ok, python_version, python_error) = detect_python3();
    let (gpp_path, gpp_ok, gpp_version, gpp_error) = detect_gpp();

    for cand in verilator_candidates() {
        let path = cand.clone();
        let mut cmd = Command::new(&path);
        cmd.arg("-V");
        let r = run_cmd_capture(cmd);
        if let Ok((code, out)) = r {
            if code == 0 && !out.trim().is_empty() {
                return ToolchainStatus {
                    verilator_path: path,
                    ok: true,
                    version: out.lines().next().unwrap_or("").to_string(),
                    error: "".to_string(),
                    make_path,
                    make_ok,
                    make_version,
                    make_error,
                    gtkwave_path,
                    gtkwave_ok,
                    gtkwave_version,
                    gtkwave_error,
                    bash_path,
                    bash_ok,
                    bash_error,
                    python_path,
                    python_ok,
                    python_version,
                    python_error,
                    gpp_path,
                    gpp_ok,
                    gpp_version,
                    gpp_error,
                };
            }
        }
    }

    ToolchainStatus {
        verilator_path: "".to_string(),
        ok: false,
        version: "".to_string(),
        error: "Verilator not found. Install it (MSYS2 UCRT64) and/or set the path.".to_string(),
        make_path,
        make_ok,
        make_version,
        make_error,
        gtkwave_path,
        gtkwave_ok,
        gtkwave_version,
        gtkwave_error,
        bash_path,
        bash_ok,
        bash_error,
        python_path,
        python_ok,
        python_version,
        python_error,
        gpp_path,
        gpp_ok,
        gpp_version,
        gpp_error,
    }
}

#[tauri::command]
fn toolchain_status() -> Result<ToolchainStatus, String> {
    Ok(detect_verilator())
}

#[tauri::command]
fn project_list(root: String) -> Result<Vec<FsNode>, String> {
    let rootp = PathBuf::from(&root);
    let canon_root = rootp.canonicalize().map_err(|e| format!("Invalid root: {e}"))?;

    let mut out: Vec<FsNode> = vec![];
    for ent in walkdir::WalkDir::new(&canon_root)
        .follow_links(false)
        .max_depth(6)
        .into_iter()
        .flatten()
    {
        let p = ent.path();
        if p == canon_root {
            continue;
        }
        let rel = p.strip_prefix(&canon_root).unwrap_or(p);
        let rels = rel.to_string_lossy().replace('\\', "/");
        let name = p.file_name().and_then(|x| x.to_str()).unwrap_or("").to_string();
        let is_dir = ent.file_type().is_dir();
        out.push(FsNode { path: rels, name, is_dir });
    }

    // Stable-ish ordering: dirs first then files, alphabetical.
    out.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.path.cmp(&b.path),
        }
    });

    Ok(out)
}

#[tauri::command]
fn project_read_file(root: String, rel_path: String) -> Result<String, String> {
    let rootp = PathBuf::from(&root);
    let p = rootp.join(&rel_path);
    ensure_within_root(&rootp, &p)?;
    fs::read_to_string(&p).map_err(|e| format!("Failed to read file: {e}"))
}

#[tauri::command]
fn project_write_file(root: String, rel_path: String, content: String) -> Result<(), String> {
    let rootp = PathBuf::from(&root);
    let p = rootp.join(&rel_path);
    ensure_within_root(&rootp, &p)?;
    fs::write(&p, content).map_err(|e| format!("Failed to write file: {e}"))
}

#[tauri::command]
fn project_mkdir(root: String, rel_path: String) -> Result<(), String> {
    let rootp = PathBuf::from(&root);
    let p = rootp.join(&rel_path);
    if rel_path.trim().is_empty() {
        return Err("Missing path".to_string());
    }
    if p.exists() {
        return Err("Path already exists".to_string());
    }
    // For create operations, validate parent is within root.
    if let Some(parent) = p.parent() {
        ensure_within_root(&rootp, parent)?;
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent dirs: {e}"))?;
    }
    fs::create_dir_all(&p).map_err(|e| format!("Failed to create dir: {e}"))
}

#[tauri::command]
fn project_create_file(root: String, rel_path: String) -> Result<(), String> {
    let rootp = PathBuf::from(&root);
    let p = rootp.join(&rel_path);
    if rel_path.trim().is_empty() {
        return Err("Missing path".to_string());
    }
    if p.exists() {
        return Err("Path already exists".to_string());
    }
    if let Some(parent) = p.parent() {
        ensure_within_root(&rootp, parent)?;
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent dirs: {e}"))?;
    }
    fs::write(&p, "").map_err(|e| format!("Failed to create file: {e}"))
}

#[tauri::command]
fn project_rename(root: String, from_rel: String, to_rel: String) -> Result<(), String> {
    let rootp = PathBuf::from(&root);
    if from_rel.trim().is_empty() || to_rel.trim().is_empty() {
        return Err("Missing path".to_string());
    }
    let from = rootp.join(&from_rel);
    let to = rootp.join(&to_rel);
    ensure_within_root(&rootp, &from)?;
    if !from.exists() {
        return Err("Source not found".to_string());
    }
    if to.exists() {
        return Err("Destination already exists".to_string());
    }
    if let Some(parent) = to.parent() {
        ensure_within_root(&rootp, parent)?;
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent dirs: {e}"))?;
    }
    fs::rename(&from, &to).map_err(|e| format!("Failed to rename: {e}"))
}

#[tauri::command]
fn project_delete(root: String, rel_path: String) -> Result<(), String> {
    let rootp = PathBuf::from(&root);
    let p = rootp.join(&rel_path);
    ensure_within_root(&rootp, &p)?;
    if !p.exists() {
        return Ok(());
    }
    let meta = fs::metadata(&p).map_err(|e| format!("Failed to stat path: {e}"))?;
    if meta.is_dir() {
        fs::remove_dir_all(&p).map_err(|e| format!("Failed to delete dir: {e}"))
    } else {
        fs::remove_file(&p).map_err(|e| format!("Failed to delete file: {e}"))
    }
}

fn load_or_init_config(root: &Path) -> Result<SvlabConfig, String> {
    let p = root.join(".svlab.json");
    if p.exists() {
        let mut cfg: SvlabConfig = read_json(&p)?;
        if cfg.filelist.trim().is_empty() {
            cfg.filelist = "files.f".to_string();
        }
        if cfg.verilator_args.is_empty() {
            cfg.verilator_args = vec!["--sv".to_string(), "-Wall".to_string(), "--timing".to_string()];
        }
        if !cfg.verilator_args.iter().any(|x| x == "--timing" || x == "--no-timing") {
            cfg.verilator_args.push("--timing".to_string());
        }
        if cfg.max_time == 0 {
            cfg.max_time = 200000;
        }
        // default trace on
        // (bool default is false if field missing)
        if cfg.plusargs.is_empty() {
            cfg.plusargs = vec![];
        }
        Ok(cfg)
    } else {
        let cfg = SvlabConfig::default();
        write_json(&p, &cfg)?;
        Ok(cfg)
    }
}

fn write_config(root: &Path, cfg: &SvlabConfig) -> Result<(), String> {
    let p = root.join(".svlab.json");
    write_json(&p, cfg)
}

fn parse_filelist(root: &Path, rel: &str) -> Vec<String> {
    let p = root.join(rel);
    let Ok(s) = fs::read_to_string(&p) else { return vec![]; };
    s.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .filter(|l| !l.starts_with('#') && !l.starts_with("//"))
        .map(|l| l.replace('\\', "/"))
        .collect()
}

fn extract_module_names(text: &str) -> Vec<String> {
    // Simple lexer-free scan for lines starting with `module <name>`.
    // Good enough for most SV projects; avoids pulling in regex crates.
    let mut out: Vec<String> = vec![];
    for raw in text.lines() {
        let line = raw.trim_start();
        if line.starts_with("module ") || line.starts_with("module\t") {
            let rest = line.trim_start_matches("module").trim();
            let name = rest
                .split(|c: char| c.is_whitespace() || c == '(' || c == '#' || c == ';')
                .next()
                .unwrap_or("")
                .trim();
            if !name.is_empty() {
                out.push(name.to_string());
            }
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TopDetectResult {
    candidates: Vec<String>,
    recommended: String,
    current: String,
}

#[tauri::command]
fn project_detect_tops(root: String) -> Result<TopDetectResult, String> {
    let rootp = PathBuf::from(&root);
    let _canon = rootp.canonicalize().map_err(|e| format!("Invalid root: {e}"))?;
    let cfg = load_or_init_config(&rootp)?;

    let mut mods: Vec<String> = vec![];

    // Prefer filelist.
    let fl = cfg.filelist.trim();
    let flp = rootp.join(fl);
    if flp.exists() {
        for rel in parse_filelist(&rootp, fl).into_iter() {
            let p = rootp.join(&rel);
            if !p.exists() { continue; }
            if let Ok(t) = fs::read_to_string(&p) {
                mods.extend(extract_module_names(&t));
            }
        }
    } else {
        // Fallback: scan a few dirs.
        for ent in walkdir::WalkDir::new(&rootp).follow_links(false).max_depth(6).into_iter().flatten() {
            if !ent.file_type().is_file() { continue; }
            let p = ent.path();
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("");
            if !(ext.eq_ignore_ascii_case("sv") || ext.eq_ignore_ascii_case("svh") || ext.eq_ignore_ascii_case("v")) { continue; }
            if let Ok(t) = fs::read_to_string(p) {
                mods.extend(extract_module_names(&t));
            }
        }
    }

    // uniq + sort
    mods.sort();
    mods.dedup();

    let current = cfg.top.trim().to_string();
    let recommended = if !current.is_empty() {
        current.clone()
    } else {
        mods.iter().find(|m| m.starts_with("tb_"))
            .or_else(|| mods.iter().find(|m| m.to_lowercase().starts_with("tb")))
            .or_else(|| mods.iter().find(|m| m.to_lowercase().contains("tb")))
            .cloned()
            .unwrap_or_else(|| mods.get(0).cloned().unwrap_or_default())
    };

    Ok(TopDetectResult { candidates: mods, recommended, current })
}

#[tauri::command]
fn project_set_top(root: String, top: String) -> Result<(), String> {
    let rootp = PathBuf::from(&root);
    let _canon = rootp.canonicalize().map_err(|e| format!("Invalid root: {e}"))?;
    let mut cfg = load_or_init_config(&rootp)?;
    cfg.top = top.trim().to_string();
    write_config(&rootp, &cfg)
}

#[tauri::command]
fn project_get_config(root: String) -> Result<SvlabConfig, String> {
    let rootp = PathBuf::from(&root);
    let _canon = rootp.canonicalize().map_err(|e| format!("Invalid root: {e}"))?;
    load_or_init_config(&rootp)
}

#[tauri::command]
fn project_set_config(root: String, cfg: SvlabConfig) -> Result<(), String> {
    let rootp = PathBuf::from(&root);
    let _canon = rootp.canonicalize().map_err(|e| format!("Invalid root: {e}"))?;
    write_config(&rootp, &cfg)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LintResult {
    code: i32,
    output: String,
}

fn msys_verilator_root_from_bin(vbin: &str) -> Option<String> {
    let s = vbin.replace('/', "\\");
    if !s.to_lowercase().contains("\\msys64\\") {
        return None;
    }
    let lower = s.to_lowercase();
    if !lower.ends_with("\\verilator_bin.exe") {
        return None;
    }
    let share = s
        .trim_end_matches("verilator_bin.exe")
        .trim_end_matches('\\')
        .trim_end_matches("bin")
        .trim_end_matches('\\')
        .to_string();
    Some(format!("{}\\share\\verilator", share))
}

fn msys_verilator_root_posix_from_bin(vbin: &str) -> Option<String> {
    let s = vbin.replace('\\', "/").to_lowercase();
    if !s.contains("/msys64/") || !s.ends_with("/verilator_bin.exe") {
        return None;
    }
    if s.contains("/ucrt64/bin/") {
        return Some("/ucrt64/share/verilator".to_string());
    }
    if s.contains("/mingw64/bin/") {
        return Some("/mingw64/share/verilator".to_string());
    }
    None
}

fn ensure_svlab_dir(root: &Path) -> Result<PathBuf, String> {
    let d = root.join(".svlab");
    fs::create_dir_all(&d).map_err(|e| format!("Failed to create .svlab dir: {e}"))?;
    Ok(d)
}

fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
    if let Ok(existing) = fs::read_to_string(path) {
        if existing == content {
            return Ok(());
        }
    }
    fs::write(path, content).map_err(|e| format!("Failed to write file: {e}"))
}

fn generate_sim_main_cpp(root: &Path, top: &str, enable_fst: bool, max_time: u64) -> Result<PathBuf, String> {
    let svlab = ensure_svlab_dir(root)?;
    let p = svlab.join("sim_main.cpp");

    let trace_includes = if enable_fst {
        "#include \"verilated_fst_c.h\"\n"
    } else {
        ""
    };

    let trace_setup = if enable_fst {
        format!(
            "  Verilated::traceEverOn(true);\n  VerilatedFstC* tfp = new VerilatedFstC();\n  top->trace(tfp, 99);\n  tfp->open(\".svlab/waves.fst\");\n"
        )
    } else {
        "".to_string()
    };

    let trace_dump = if enable_fst {
        "    tfp->dump(main_time);\n"
    } else {
        ""
    };

    let trace_close = if enable_fst {
        "  tfp->close();\n  delete tfp;\n"
    } else {
        ""
    };

    let content = format!(
        "#include <verilated.h>\n{}#include \"V{}.h\"\n\nstatic vluint64_t main_time = 0;\n\ndouble sc_time_stamp() {{ return (double)main_time; }}\n\nint main(int argc, char** argv) {{\n  Verilated::commandArgs(argc, argv);\n  V{}* top = new V{};\n{}\n  const vluint64_t max_time = {};\n  while (!Verilated::gotFinish() && main_time < max_time) {{\n    top->eval();\n{}    main_time++;\n    Verilated::timeInc(1);\n  }}\n{}\n  top->final();\n  delete top;\n  return 0;\n}}\n",
        trace_includes,
        top,
        top,
        top,
        trace_setup,
        max_time,
        trace_dump,
        trace_close
    );

    write_if_changed(&p, &content)?;
    Ok(p)
}

#[tauri::command]
fn project_lint(root: String, verilator_path: Option<String>) -> Result<LintResult, String> {
    let rootp = PathBuf::from(&root);
    let _canon = rootp.canonicalize().map_err(|e| format!("Invalid root: {e}"))?;
    let cfg = load_or_init_config(&rootp)?;

    let vpath = verilator_path
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| detect_verilator().verilator_path);

    if vpath.trim().is_empty() {
        return Err("Verilator not found. Configure toolchain path.".to_string());
    }

    // Prefer filelist if present.
    let fl = cfg.filelist.trim();
    let flp = rootp.join(fl);

    if cfg!(windows) && is_msys2_path(&vpath) {
        // Run inside MSYS2 bash so /ucrt64 paths + python scripts work.
        let mut parts: Vec<String> = vec![];
        parts.push(format!("\"{}\"", vpath.replace('"', "\\\"")));
        parts.push("--lint-only".to_string());
        for a in cfg.verilator_args.iter() {
            parts.push(a.clone());
        }
        for d in cfg.include_dirs.iter() {
            parts.push(format!("-I{}", d));
        }
        for def in cfg.defines.iter() {
            parts.push(format!("-D{}", def));
        }
        if flp.exists() {
            parts.push("-f".to_string());
            parts.push(fl.to_string());
        }
        let cmdline = format!("VERILATOR_ROOT=/ucrt64/share/verilator {}", parts.join(" "));
        let (code, output) = run_msys2_bash(&rootp, &cmdline)?;
        return Ok(LintResult { code, output });
    }

    let mut cmd = Command::new(&vpath);
    cmd.current_dir(&rootp);

    if let Some(vroot) = msys_verilator_root_from_bin(&vpath) {
        cmd.env("VERILATOR_ROOT", vroot);
    }

    cmd.arg("--lint-only");
    for a in cfg.verilator_args.iter() {
        cmd.arg(a);
    }
    for d in cfg.include_dirs.iter() {
        cmd.arg(format!("-I{}", d));
    }
    for def in cfg.defines.iter() {
        cmd.arg(format!("-D{}", def));
    }

    if flp.exists() {
        cmd.arg("-f");
        cmd.arg(fl);
    } else {
        for ent in walkdir::WalkDir::new(&rootp)
            .follow_links(false)
            .max_depth(6)
            .into_iter()
            .flatten()
        {
            if !ent.file_type().is_file() {
                continue;
            }
            let p = ent.path();
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("");
            if ext.eq_ignore_ascii_case("sv") || ext.eq_ignore_ascii_case("svh") || ext.eq_ignore_ascii_case("v") {
                let rel = p.strip_prefix(&rootp).unwrap_or(p).to_string_lossy().to_string();
                cmd.arg(rel);
            }
        }
    }

    let (code, output) = run_cmd_capture(cmd)?;
    Ok(LintResult { code, output })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BuildResult {
    code: i32,
    output: String,
    exe_path: String,
    waves_path: String,
}

fn guess_make_path() -> String {
    let (p, ok, _, _) = detect_make();
    if ok { p } else { "".to_string() }
}

#[tauri::command]
async fn project_build(
    root: String,
    verilator_path: Option<String>,
    make_path: Option<String>,
    clean: Option<bool>,
) -> Result<BuildResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rootp = PathBuf::from(&root);
        let _canon = rootp.canonicalize().map_err(|e| format!("Invalid root: {e}"))?;
        let cfg = load_or_init_config(&rootp)?;

    let vpath = verilator_path
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| detect_verilator().verilator_path);
    if vpath.trim().is_empty() {
        return Err("Verilator not found".to_string());
    }

    let mpath = make_path
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| guess_make_path());
    if mpath.trim().is_empty() {
        return Err("make not found".to_string());
    }

    let top = cfg.top.trim();
    if top.is_empty() {
        return Err("Set .svlab.json top first".to_string());
    }

    let _enable_fst = cfg.verilator_args.iter().any(|x| x == "--trace-fst") || cfg.verilator_args.iter().any(|x| x == "--trace");
    let _sim_main = generate_sim_main_cpp(&rootp, top, cfg.trace, cfg.max_time)?;

    // Optional clean build.
    let obj_dir = rootp.join("obj_dir");
    if clean.unwrap_or(false) {
        if obj_dir.exists() {
            // best-effort; ignore errors if something holds locks
            let _ = fs::remove_dir_all(&obj_dir);
        }
    }

    // 1) Verilator codegen (generates obj_dir)
    let mut vcmd = Command::new(&vpath);
    vcmd.current_dir(&rootp);
    // MSYS2 builds: we'll invoke verilator via bash -lc so paths resolve.
    // Non-MSYS builds still get VERILATOR_ROOT set to help find built-ins.
    if !cfg!(windows) || !is_msys2_path(&vpath) {
        if let Some(vroot) = msys_verilator_root_from_bin(&vpath) {
            vcmd.env("VERILATOR_ROOT", vroot);
        }
    }

    vcmd.arg("-cc");
    for a in cfg.verilator_args.iter() {
        // ensure timing is present already
        vcmd.arg(a);
    }
    vcmd.arg("--exe");
    // Pass relative path to avoid Windows/MSYS path weirdness.
    vcmd.arg(".svlab/sim_main.cpp");
    vcmd.arg("--top-module");
    vcmd.arg(top);
    if cfg.trace {
        vcmd.arg("--trace-fst");
    }

    for d in cfg.include_dirs.iter() {
        vcmd.arg(format!("-I{}", d));
    }
    for def in cfg.defines.iter() {
        vcmd.arg(format!("-D{}", def));
    }

    let fl = cfg.filelist.trim();
    let flp = rootp.join(fl);
    if flp.exists() {
        vcmd.arg("-f");
        vcmd.arg(fl);
    } else {
        // fallback: scan
        for ent in walkdir::WalkDir::new(&rootp).follow_links(false).max_depth(6).into_iter().flatten() {
            if !ent.file_type().is_file() { continue; }
            let p = ent.path();
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("");
            if ext.eq_ignore_ascii_case("sv") || ext.eq_ignore_ascii_case("svh") || ext.eq_ignore_ascii_case("v") {
                let rel = p.strip_prefix(&rootp).unwrap_or(p).to_string_lossy().to_string();
                vcmd.arg(rel);
            }
        }
    }

    let (vcode, vout) = if cfg!(windows) && is_msys2_path(&vpath) {
        // Run via MSYS2 bash so VERILATOR_ROOT=/ucrt64/... and python scripts resolve.
        let mut parts: Vec<String> = vec![];
        parts.push(format!("\"{}\"", vpath.replace('"', "\\\"")));
        parts.push("-cc".to_string());
        for a in cfg.verilator_args.iter() {
            parts.push(a.clone());
        }
        parts.push("--exe".to_string());
        parts.push(".svlab/sim_main.cpp".to_string());
        parts.push("--top-module".to_string());
        parts.push(top.to_string());
        if cfg.trace {
            parts.push("--trace-fst".to_string());
        }
        for d in cfg.include_dirs.iter() {
            parts.push(format!("-I{}", d));
        }
        for def in cfg.defines.iter() {
            parts.push(format!("-D{}", def));
        }
        let fl = cfg.filelist.trim();
        let flp = rootp.join(fl);
        if flp.exists() {
            parts.push("-f".to_string());
            parts.push(fl.to_string());
        }
        let cmdline = format!("VERILATOR_ROOT=/ucrt64/share/verilator {}", parts.join(" "));
        run_msys2_bash(&rootp, &cmdline)?
    } else {
        run_cmd_capture(vcmd)?
    };

    if vcode != 0 {
        return Ok(BuildResult { code: vcode, output: vout, exe_path: "".to_string(), waves_path: "".to_string() });
    }

    // 2) make
    let mk = format!("V{}.mk", top);
    let mut mcmd = Command::new(&mpath);
    mcmd.current_dir(&rootp);

    // If using MSYS2 tools from Windows, ensure core Unix utils resolve (sh, rm, cat, xargs, uname) and
    // prefer MSYS2 toolchain (ar) over anything else on PATH (e.g. Strawberry Perl's binutils).
    if cfg!(windows) && mpath.to_lowercase().contains("\\msys64\\") {
        // Run make via MSYS2 bash so /usr/bin tools resolve cleanly.
        let cmdline = format!(
            "VERILATOR_ROOT=/ucrt64/share/verilator \"{}\" -C obj_dir -f {} -j",
            mpath.replace('"', "\\\""),
            mk
        );
        let (mcode, mout) = run_msys2_bash(&rootp, &cmdline)?;

        let mut out = String::new();
        out.push_str(&vout);
        if !out.is_empty() && !out.ends_with('\n') { out.push('\n'); }
        out.push_str(&mout);

        let mut exe_rel = format!("obj_dir/V{}", top);
        if cfg!(windows) {
            exe_rel.push_str(".exe");
        }
        let waves_rel = ".svlab/waves.fst".to_string();
        return Ok(BuildResult { code: mcode, output: out.trim().to_string(), exe_path: exe_rel, waves_path: waves_rel });
    }

    mcmd.arg("-C");
    mcmd.arg("obj_dir");
    mcmd.arg("-f");
    mcmd.arg(&mk);
    mcmd.arg("-j");

    let (mcode, mout) = run_cmd_capture(mcmd)?;
    let mut out = String::new();
    out.push_str(&vout);
    if !out.is_empty() && !out.ends_with('\n') { out.push('\n'); }
    out.push_str(&mout);

    let mut exe_rel = format!("obj_dir/V{}", top);
    if cfg!(windows) {
        exe_rel.push_str(".exe");
    }
    let waves_rel = ".svlab/waves.fst".to_string();

    Ok(BuildResult { code: mcode, output: out.trim().to_string(), exe_path: exe_rel, waves_path: waves_rel })
    })
    .await
    .map_err(|e| format!("Build task failed: {e}"))?
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RunResult {
    code: i32,
    output: String,
}

#[tauri::command]
fn project_open_waves(root: String, waves_rel: String, gtkwave_path: Option<String>) -> Result<(), String> {
    let rootp = PathBuf::from(&root);
    let waves = rootp.join(&waves_rel);
    if !waves.exists() {
        return Err("Waves file not found. Run the simulation first.".to_string());
    }

    let gpath = gtkwave_path
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| detect_gtkwave().0);
    if gpath.trim().is_empty() {
        return Err("GTKWave not found. Install it via MSYS2 and/or set path.".to_string());
    }

    if cfg!(windows) && is_msys2_path(&gpath) {
        // Use bash -lc so MSYS2 GUI app launches with correct env.
        // IMPORTANT: spawn (do not wait), otherwise the UI appears frozen until GTKWave exits.
        let cmdline = format!("\"{}\" \"{}\"", gpath.replace('"', "\\\""), waves_rel);

        let bash = msys2_bash_path();
        if !PathBuf::from(&bash).exists() {
            return Err("MSYS2 bash.exe not found at C:\\msys64\\usr\\bin\\bash.exe".to_string());
        }

        let mut cmd = Command::new(&bash);
        cmd.current_dir(&rootp);
        cmd.arg("-lc");
        cmd.arg(&cmdline);
        cmd.env("CHERE_INVOKING", "1");
        cmd.env("MSYSTEM", "UCRT64");
        let cur_path = std::env::var("PATH").unwrap_or_default();
        let prefix = "C:\\msys64\\usr\\bin;C:\\msys64\\ucrt64\\bin;";
        cmd.env("PATH", format!("{}{}", prefix, cur_path));

        #[cfg(windows)]
        {
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        cmd.spawn().map_err(|e| format!("Failed to launch GTKWave: {e}"))?;
        return Ok(());
    }

    let mut cmd = Command::new(&gpath);
    cmd.current_dir(&rootp);
    cmd.arg(waves_rel);
    // Don't wait; we just spawn.
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map_err(|e| format!("Failed to launch GTKWave: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn project_run(root: String, exe_rel: String) -> Result<RunResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rootp = PathBuf::from(&root);
        let mut exe = rootp.join(&exe_rel);
    // exe may not exist yet; don't canonicalize.
    if !exe.exists() {
        if cfg!(windows) {
            let alt_rel = format!("{}.exe", exe_rel.trim_end_matches(".exe"));
            let alt = rootp.join(alt_rel);
            if alt.exists() {
                exe = alt;
            } else {
                return Err("Executable not found. Build first.".to_string());
            }
        } else {
            return Err("Executable not found. Build first.".to_string());
        }
    }
        let mut cmd = Command::new(&exe);
        cmd.current_dir(&rootp);

        // Pass configured plusargs (and any other args) to the sim.
        if let Ok(cfg) = load_or_init_config(&rootp) {
            for a in cfg.plusargs.iter() {
                let t = a.trim();
                if t.is_empty() { continue; }
                cmd.arg(t);
            }
        }

        let (code, out) = run_cmd_capture(cmd)?;
        Ok(RunResult { code, output: out })
    })
    .await
    .map_err(|e| format!("Run task failed: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            toolchain_status,
            project_list,
            project_read_file,
            project_write_file,
            project_mkdir,
            project_create_file,
            project_rename,
            project_delete,
            project_lint,
            project_detect_tops,
            project_set_top,
            project_get_config,
            project_set_config,
            project_build,
            project_run,
            project_open_waves
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
