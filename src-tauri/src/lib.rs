use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use diffy::apply;
use diffy::Patch;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};

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
            verilator_args: vec![
                "--sv".to_string(),
                "-Wall".to_string(),
                "--timing".to_string(),
            ],
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

#[allow(dead_code)]
fn canonicalize_lossy(p: &Path) -> Result<String, String> {
    p.canonicalize()
        .map_err(|e| format!("Failed to canonicalize path: {e}"))
        .map(|x| x.to_string_lossy().to_string())
}

fn ensure_within_root(root: &Path, p: &Path) -> Result<(), String> {
    let canon_root = root
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize root: {e}"))?;

    // If the target exists, canonicalize it; otherwise canonicalize its parent.
    // This allows safe checks for create/write operations.
    let canon = if p.exists() {
        p.canonicalize()
            .map_err(|e| format!("Failed to canonicalize path: {e}"))?
    } else {
        let parent = p.parent().ok_or_else(|| "Invalid path".to_string())?;
        parent
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize parent: {e}"))?
    };

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
    let s =
        serde_json::to_string_pretty(v).map_err(|e| format!("Failed to serialize JSON: {e}"))?;
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

    let out = cmd
        .output()
        .map_err(|e| format!("Failed to run command: {e}"))?;
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
                return (
                    path,
                    true,
                    out.lines().next().unwrap_or("").to_string(),
                    "".to_string(),
                );
            }
        }
    }
    (
        "".to_string(),
        false,
        "".to_string(),
        "make not found".to_string(),
    )
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
                let ver = out
                    .lines()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("")
                    .to_string();
                return (path, true, ver, "".to_string());
            }
        }
    }
    (
        "".to_string(),
        false,
        "".to_string(),
        "gtkwave not found".to_string(),
    )
}

fn detect_bash() -> (String, bool, String) {
    if cfg!(windows) {
        let p = PathBuf::from("C:\\msys64\\usr\\bin\\bash.exe");
        if p.exists() {
            return (p.to_string_lossy().to_string(), true, "".to_string());
        }
        return (
            "".to_string(),
            false,
            "MSYS2 bash.exe not found at C:\\msys64\\usr\\bin\\bash.exe".to_string(),
        );
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
                let ver = out
                    .lines()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("")
                    .to_string();
                return (cand, true, ver, "".to_string());
            }
        }
    }

    (
        "".to_string(),
        false,
        "".to_string(),
        "python3 not found".to_string(),
    )
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
                let ver = out
                    .lines()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("")
                    .to_string();
                return (cand, true, ver, "".to_string());
            }
        }
    }

    (
        "".to_string(),
        false,
        "".to_string(),
        "g++ not found".to_string(),
    )
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
    let canon_root = rootp
        .canonicalize()
        .map_err(|e| format!("Invalid root: {e}"))?;

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
        let name = p
            .file_name()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_string();
        let is_dir = ent.file_type().is_dir();
        out.push(FsNode {
            path: rels,
            name,
            is_dir,
        });
    }

    // Stable-ish ordering: dirs first then files, alphabetical.
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.path.cmp(&b.path),
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
fn project_exists(root: String, rel_path: String) -> Result<bool, String> {
    let rootp = PathBuf::from(&root);
    let p = rootp.join(&rel_path);
    ensure_within_root(&rootp, &p)?;
    Ok(p.exists())
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
            cfg.verilator_args = vec![
                "--sv".to_string(),
                "-Wall".to_string(),
                "--timing".to_string(),
            ];
        }
        if !cfg
            .verilator_args
            .iter()
            .any(|x| x == "--timing" || x == "--no-timing")
        {
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
    let Ok(s) = fs::read_to_string(&p) else {
        return vec![];
    };
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
    let _canon = rootp
        .canonicalize()
        .map_err(|e| format!("Invalid root: {e}"))?;
    let cfg = load_or_init_config(&rootp)?;

    let mut mods: Vec<String> = vec![];

    // Prefer filelist.
    let fl = cfg.filelist.trim();
    let flp = rootp.join(fl);
    if flp.exists() {
        for rel in parse_filelist(&rootp, fl).into_iter() {
            let p = rootp.join(&rel);
            if !p.exists() {
                continue;
            }
            if let Ok(t) = fs::read_to_string(&p) {
                mods.extend(extract_module_names(&t));
            }
        }
    } else {
        // Fallback: scan a few dirs.
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
            if !(ext.eq_ignore_ascii_case("sv")
                || ext.eq_ignore_ascii_case("svh")
                || ext.eq_ignore_ascii_case("v"))
            {
                continue;
            }
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
        mods.iter()
            .find(|m| m.starts_with("tb_"))
            .or_else(|| mods.iter().find(|m| m.to_lowercase().starts_with("tb")))
            .or_else(|| mods.iter().find(|m| m.to_lowercase().contains("tb")))
            .cloned()
            .unwrap_or_else(|| mods.get(0).cloned().unwrap_or_default())
    };

    Ok(TopDetectResult {
        candidates: mods,
        recommended,
        current,
    })
}

#[tauri::command]
fn project_set_top(root: String, top: String) -> Result<(), String> {
    let rootp = PathBuf::from(&root);
    let _canon = rootp
        .canonicalize()
        .map_err(|e| format!("Invalid root: {e}"))?;
    let mut cfg = load_or_init_config(&rootp)?;
    cfg.top = top.trim().to_string();
    write_config(&rootp, &cfg)
}

#[tauri::command]
fn project_get_config(root: String) -> Result<SvlabConfig, String> {
    let rootp = PathBuf::from(&root);
    let _canon = rootp
        .canonicalize()
        .map_err(|e| format!("Invalid root: {e}"))?;
    load_or_init_config(&rootp)
}

#[tauri::command]
fn project_set_config(root: String, cfg: SvlabConfig) -> Result<(), String> {
    let rootp = PathBuf::from(&root);
    let _canon = rootp
        .canonicalize()
        .map_err(|e| format!("Invalid root: {e}"))?;
    write_config(&rootp, &cfg)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectSetupProbe {
    has_config: bool,
    has_filelist: bool,
    filelist_rel: String,
    has_rtl: bool,
    has_tb: bool,
    sv_count: usize,
}

#[tauri::command]
fn project_setup_probe(root: String) -> Result<ProjectSetupProbe, String> {
    let rootp = PathBuf::from(&root);
    let _canon = rootp
        .canonicalize()
        .map_err(|e| format!("Invalid root: {e}"))?;

    let cfg_path = rootp.join(".svlab.json");
    let has_config = cfg_path.exists();

    // If config exists, use its filelist; otherwise default to files.f
    let filelist_rel = if has_config {
        let cfg: SvlabConfig = read_json(&cfg_path).unwrap_or_default();
        let rel = cfg.filelist.trim().to_string();
        if rel.is_empty() {
            "files.f".to_string()
        } else {
            rel
        }
    } else {
        "files.f".to_string()
    };

    let has_filelist = rootp.join(&filelist_rel).exists();
    let has_rtl = rootp.join("rtl").is_dir();
    let has_tb = rootp.join("tb").is_dir();

    // Count SV-ish files (helps decide if we should prompt)
    let mut sv_count: usize = 0;
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
        // skip common heavy/irrelevant dirs
        if p.components().any(|c| {
            let s = c.as_os_str().to_string_lossy().to_lowercase();
            s == ".svlab" || s == "node_modules" || s == "dist" || s == "target" || s == ".git"
        }) {
            continue;
        }
        let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("");
        if ext.eq_ignore_ascii_case("sv")
            || ext.eq_ignore_ascii_case("svh")
            || ext.eq_ignore_ascii_case("v")
        {
            sv_count += 1;
        }
    }

    Ok(ProjectSetupProbe {
        has_config,
        has_filelist,
        filelist_rel,
        has_rtl,
        has_tb,
        sv_count,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectSetupApplyResult {
    wrote_config: bool,
    wrote_filelist: bool,
    filelist_rel: String,
    created_dirs: Vec<String>,
    file_count: usize,
}

fn relpath_from_root(root: &Path, p: &Path) -> Option<String> {
    let rel = p.strip_prefix(root).ok()?;
    Some(rel.to_string_lossy().replace('\\', "/"))
}

fn generate_filelist_entries(root: &Path) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for ent in walkdir::WalkDir::new(root)
        .follow_links(false)
        .max_depth(10)
        .into_iter()
        .flatten()
    {
        if !ent.file_type().is_file() {
            continue;
        }
        let p = ent.path();
        if p.components().any(|c| {
            let s = c.as_os_str().to_string_lossy().to_lowercase();
            s == ".svlab" || s == "node_modules" || s == "dist" || s == "target" || s == ".git"
        }) {
            continue;
        }
        let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("");
        if !(ext.eq_ignore_ascii_case("sv")
            || ext.eq_ignore_ascii_case("svh")
            || ext.eq_ignore_ascii_case("v"))
        {
            continue;
        }
        if let Some(rel) = relpath_from_root(root, p) {
            out.push(rel);
        }
    }
    out.sort();
    out.dedup();
    out
}

#[tauri::command]
fn project_setup_apply(
    root: String,
    create_rtl: bool,
    create_tb: bool,
    write_filelist: bool,
    overwrite_filelist: bool,
    set_top: Option<String>,
) -> Result<ProjectSetupApplyResult, String> {
    let rootp = PathBuf::from(&root);
    let _canon = rootp
        .canonicalize()
        .map_err(|e| format!("Invalid root: {e}"))?;

    let mut created_dirs: Vec<String> = vec![];

    if create_rtl {
        let d = rootp.join("rtl");
        if !d.exists() {
            fs::create_dir_all(&d).map_err(|e| format!("Failed to create rtl/: {e}"))?;
            created_dirs.push("rtl".to_string());
        }
    }
    if create_tb {
        let d = rootp.join("tb");
        if !d.exists() {
            fs::create_dir_all(&d).map_err(|e| format!("Failed to create tb/: {e}"))?;
            created_dirs.push("tb".to_string());
        }
    }

    // Ensure config exists and read it.
    let mut cfg = load_or_init_config(&rootp)?;
    let wrote_config = true; // load_or_init_config will create if missing

    // Filelist handling
    let filelist_rel = if cfg.filelist.trim().is_empty() {
        "files.f".to_string()
    } else {
        cfg.filelist.trim().to_string()
    };

    let mut wrote_filelist_flag = false;
    let mut file_count: usize = 0;

    if write_filelist {
        let flp = rootp.join(&filelist_rel);
        if !flp.exists() || overwrite_filelist {
            let entries = generate_filelist_entries(&rootp);
            file_count = entries.len();
            let mut content = String::new();
            content.push_str("# Autogenerated by svAi\n");
            content.push_str("# Paths are relative to the project root\n\n");
            for e in entries {
                content.push_str(&e);
                content.push('\n');
            }
            fs::write(&flp, content).map_err(|e| format!("Failed to write filelist: {e}"))?;
            wrote_filelist_flag = true;
        }
    }

    if let Some(t) = set_top {
        let top = t.trim().to_string();
        if !top.is_empty() {
            cfg.top = top;
            write_config(&rootp, &cfg)?;
        }
    }

    Ok(ProjectSetupApplyResult {
        wrote_config,
        wrote_filelist: wrote_filelist_flag,
        filelist_rel,
        created_dirs,
        file_count,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectNewResult {
    root: String,
    created: bool,
    top: String,
    filelist: String,
    tb: String,
    rtl: String,
}

fn sanitize_name(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == ' ')
        .collect::<String>()
        .trim()
        .replace(' ', "-")
}

fn sanitize_sv_ident(s: &str) -> String {
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i == 0 {
            if c.is_ascii_alphabetic() || c == '_' {
                out.push(c);
            } else if c.is_ascii_digit() {
                out.push('_');
                out.push(c);
            }
            continue;
        }
        if c.is_ascii_alphanumeric() || c == '_' {
            out.push(c);
        }
    }
    if out.is_empty() {
        "top".to_string()
    } else {
        out
    }
}

fn ensure_child_dir(parent: &Path, child: &Path) -> Result<(), String> {
    let canon_parent = parent
        .canonicalize()
        .map_err(|e| format!("Invalid parent: {e}"))?;
    let canon_child = child
        .canonicalize()
        .map_err(|e| format!("Invalid child path: {e}"))?;
    if !canon_child.starts_with(&canon_parent) {
        return Err("Refusing to create project outside chosen parent directory".to_string());
    }
    Ok(())
}

#[tauri::command]
fn project_new_create(
    parent_dir: String,
    name: String,
    top: String,
) -> Result<ProjectNewResult, String> {
    let parent = PathBuf::from(&parent_dir);
    let _canon = parent
        .canonicalize()
        .map_err(|e| format!("Invalid parent dir: {e}"))?;

    let safe_name = sanitize_name(&name);
    if safe_name.is_empty() {
        return Err("Project name is required".to_string());
    }

    let safe_top = sanitize_sv_ident(&top);
    let tb_top = format!("tb_{}", safe_top);

    let rootp = parent.join(&safe_name);
    if rootp.exists() {
        return Err("Destination folder already exists".to_string());
    }

    // Create structure
    fs::create_dir_all(rootp.join("rtl")).map_err(|e| format!("Failed to create rtl/: {e}"))?;
    fs::create_dir_all(rootp.join("tb")).map_err(|e| format!("Failed to create tb/: {e}"))?;

    // Verify location (after creation)
    ensure_child_dir(&parent, &rootp)?;

    // Starter RTL
    let rtl_rel = format!("rtl/{}.sv", safe_top);
    let rtl_path = rootp.join(&rtl_rel);
    let rtl_text = format!("module {top}();\n\nendmodule\n", top = safe_top);
    fs::write(&rtl_path, rtl_text).map_err(|e| format!("Failed to write RTL: {e}"))?;

    // Starter TB
    let tb_rel = format!("tb/{}.sv", tb_top);
    let tb_path = rootp.join(&tb_rel);
    let tb_text = format!(
        "`timescale 1ns/1ps\n\nmodule {tb}();\n  // TODO: instantiate DUT + write stimulus\n\n  initial begin\n    $display(\"TODO: write test\");\n    $finish;\n  end\nendmodule\n",
        tb = tb_top
    );
    fs::write(&tb_path, tb_text).map_err(|e| format!("Failed to write TB: {e}"))?;

    // Filelist
    let filelist_rel = "files.f".to_string();
    let fl_text = format!(
        "# Autogenerated by svAi\n# Paths are relative to the project root\n\n{rtl}\n{tb}\n",
        rtl = rtl_rel,
        tb = tb_rel
    );
    fs::write(rootp.join(&filelist_rel), fl_text)
        .map_err(|e| format!("Failed to write files.f: {e}"))?;

    // Config
    let mut cfg = SvlabConfig::default();
    cfg.top = tb_top.clone();
    cfg.filelist = filelist_rel.clone();
    cfg.include_dirs = vec!["rtl".to_string(), "tb".to_string()];
    write_config(&rootp, &cfg)?;

    Ok(ProjectNewResult {
        root: rootp.to_string_lossy().to_string(),
        created: true,
        top: cfg.top,
        filelist: cfg.filelist,
        tb: tb_rel,
        rtl: rtl_rel,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AiMessage {
    role: String,
    content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AiProvider {
    // "ollama" | "openai_compat"
    kind: String,
    base_url: String,
    model: String,
    #[serde(default)]
    api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AiChatResult {
    code: i32,
    output: String,
}

fn gather_project_text(root: &Path, max_files: usize, max_chars: usize) -> Result<String, String> {
    let cfg = load_or_init_config(root)?;

    // Prefer filelist to avoid reading junk.
    let mut rels: Vec<String> = vec![];
    let fl = cfg.filelist.trim();
    if !fl.is_empty() {
        let flp = root.join(fl);
        if flp.exists() {
            rels = parse_filelist(root, fl);
        }
    }

    // Fallback: scan.
    if rels.is_empty() {
        for ent in walkdir::WalkDir::new(root)
            .follow_links(false)
            .max_depth(10)
            .into_iter()
            .flatten()
        {
            if !ent.file_type().is_file() {
                continue;
            }
            let p = ent.path();
            if p.components().any(|c| {
                let s = c.as_os_str().to_string_lossy().to_lowercase();
                s == ".svlab" || s == "node_modules" || s == "dist" || s == "target" || s == ".git"
            }) {
                continue;
            }
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("");
            if ext.eq_ignore_ascii_case("sv")
                || ext.eq_ignore_ascii_case("svh")
                || ext.eq_ignore_ascii_case("v")
            {
                if let Some(r) = relpath_from_root(root, p) {
                    rels.push(r);
                }
            }
        }
        rels.sort();
        rels.dedup();
    }

    let mut out = String::new();
    out.push_str("# svAi Project Context\n\n");
    out.push_str("## .svlab.json\n");
    out.push_str(&serde_json::to_string_pretty(&cfg).unwrap_or_default());
    out.push_str("\n\n");

    let mut count = 0usize;
    for rel in rels {
        if count >= max_files {
            break;
        }
        let p = root.join(&rel);
        if !p.exists() {
            continue;
        }
        let Ok(txt) = fs::read_to_string(&p) else {
            continue;
        };
        // crude cap per file
        if txt.len() > 120_000 {
            continue;
        }
        let chunk = format!("\n\n## File: {}\n```systemverilog\n{}\n```\n", rel, txt);
        if out.len() + chunk.len() > max_chars {
            break;
        }
        out.push_str(&chunk);
        count += 1;
    }

    Ok(out)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PatchApplyResult {
    ok: bool,
    file: String,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PatchPreviewResult {
    ok: bool,
    file: String,
    start_line: usize,
    after: String,
    message: String,
}

fn extract_patch_target_file(patch_text: &str) -> Result<String, String> {
    // Prefer +++ b/<file>
    for line in patch_text.lines() {
        if let Some(rest) = line.strip_prefix("+++ ") {
            let f = rest.trim();
            if f.starts_with("b/") {
                return Ok(f.trim_start_matches("b/").to_string());
            }
            if f != "/dev/null" {
                return Ok(f.to_string());
            }
        }
    }
    Err("Couldn't determine patch target file (expected +++ b/<file>)".to_string())
}

fn strip_to_unified_diff(patch_text: &str) -> String {
    let p = patch_text.replace("\r\n", "\n");
    if p.starts_with("--- ") {
        return p;
    }
    if let Some((_before, after)) = p.split_once("\n--- ") {
        return format!("--- {}", after);
    }
    p
}

fn parse_first_new_start(patch_text: &str) -> Option<usize> {
    // @@ -a,b +c,d @@
    for line in patch_text.lines() {
        if let Some(rest) = line.strip_prefix("@@") {
            // cheap parse: find +<num>
            if let Some(plus) = rest.find('+') {
                let after = &rest[plus + 1..];
                let num: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(n) = num.parse::<usize>() {
                    return Some(n);
                }
            }
        }
    }
    None
}

fn ensure_unified_headers(patch_text: &str) -> String {
    // If the model only outputs +++ but not ---, synthesize the missing header.
    let mut p = patch_text.to_string();

    let has_old = p.contains("\n--- ") || p.starts_with("--- ");
    let has_new = p.contains("\n+++ ") || p.starts_with("+++ ");

    if has_new && !has_old {
        // Find the first +++ line and derive --- a/<file>.
        if let Some(line) = p.lines().find(|l| l.starts_with("+++ ")) {
            let mut f = line.trim_start_matches("+++ ").trim().to_string();
            if f.starts_with("b/") {
                f = format!("a/{}", f.trim_start_matches("b/"));
            }
            let insert = format!("--- {}\n", f);
            // Insert before the +++ line.
            if let Some(idx) = p.find(line) {
                p.insert_str(idx, &insert);
            } else {
                p = format!("{}{}", insert, p);
            }
        }
    }

    if has_old && !has_new {
        if let Some(line) = p.lines().find(|l| l.starts_with("--- ")) {
            let mut f = line.trim_start_matches("--- ").trim().to_string();
            if f.starts_with("a/") {
                f = format!("b/{}", f.trim_start_matches("a/"));
            }
            let insert = format!("+++ {}\n", f);
            // Insert after the --- line.
            if let Some(idx) = p.find(line) {
                let at = idx + line.len();
                p.insert_str(at, &format!("\n{}", insert.trim_end()));
            } else {
                p.push_str("\n");
                p.push_str(&insert);
            }
        }
    }

    p
}

fn normalize_hunk_prefixes(patch_text: &str) -> String {
    // Many models omit the leading " "/"+"/"-" prefixes on hunk lines.
    // Fix-up: for lines within a hunk, prefix a single space if missing.
    let mut out: Vec<String> = Vec::new();
    let mut in_hunk = false;

    for raw in patch_text.replace("\r\n", "\n").lines() {
        let line = raw.to_string();

        if line.starts_with("@@") {
            in_hunk = true;
            out.push(line);
            continue;
        }
        if in_hunk {
            // next file header or end of patch exits hunk
            if line.starts_with("--- ") || line.starts_with("+++ ") {
                in_hunk = false;
                out.push(line);
                continue;
            }

            if line.is_empty() {
                out.push(" ".to_string());
                continue;
            }

            let c0 = line.chars().next().unwrap_or(' ');
            if c0 == ' ' || c0 == '+' || c0 == '-' || c0 == '\\' {
                out.push(line);
            } else {
                out.push(format!(" {}", line));
            }
            continue;
        }

        out.push(line);
    }

    out.join("\n")
}

fn apply_patch_to_text(old_raw: &str, patch_text: &str) -> Result<String, String> {
    let old = old_raw.replace("\r\n", "\n");
    let patch_for_diffy =
        normalize_hunk_prefixes(&ensure_unified_headers(&strip_to_unified_diff(patch_text)));

    // Validate headers exist
    let has_old = patch_for_diffy.contains("\n--- ") || patch_for_diffy.starts_with("--- ");
    let has_new = patch_for_diffy.contains("\n+++ ") || patch_for_diffy.starts_with("+++ ");
    if !has_old || !has_new {
        return Err("Patch must include --- and +++ headers".to_string());
    }

    let patch_obj = Patch::from_str(&patch_for_diffy).map_err(|e| format!("Invalid patch: {e}"))?;
    apply(&old, &patch_obj).map_err(|e| format!("Patch didn't apply cleanly: {e}"))
}

#[tauri::command]
fn project_patch_preview(root: String, patch: String) -> Result<PatchPreviewResult, String> {
    let rootp = PathBuf::from(&root);
    let _canon = rootp
        .canonicalize()
        .map_err(|e| format!("Invalid root: {e}"))?;

    let target_rel = extract_patch_target_file(&patch)?;
    let target_rel_norm = target_rel.replace('\\', "/");
    let p = rootp.join(&target_rel_norm);
    ensure_within_root(&rootp, &p)?;

    let old_raw = fs::read_to_string(&p).map_err(|e| format!("Failed to read target file: {e}"))?;
    let new = apply_patch_to_text(&old_raw, &patch)?;

    let patch_for_diffy = strip_to_unified_diff(&patch);
    let start_line = parse_first_new_start(&patch_for_diffy).unwrap_or(1);

    let lines: Vec<&str> = new.split('\n').collect();
    let idx = start_line.saturating_sub(1);
    let end = (idx + 8).min(lines.len());
    let after = lines[idx..end].join("\n");

    Ok(PatchPreviewResult {
        ok: true,
        file: target_rel_norm,
        start_line,
        after,
        message: "OK".to_string(),
    })
}

#[tauri::command]
fn project_apply_patch(root: String, patch: String) -> Result<PatchApplyResult, String> {
    let rootp = PathBuf::from(&root);
    let _canon = rootp
        .canonicalize()
        .map_err(|e| format!("Invalid root: {e}"))?;

    let target_rel = extract_patch_target_file(&patch)?;
    let target_rel_norm = target_rel.replace('\\', "/");
    let p = rootp.join(&target_rel_norm);
    ensure_within_root(&rootp, &p)?;

    let old_raw = fs::read_to_string(&p).map_err(|e| format!("Failed to read target file: {e}"))?;
    let had_crlf = old_raw.contains("\r\n");

    let mut new = apply_patch_to_text(&old_raw, &patch)?;
    if had_crlf {
        new = new.replace("\n", "\r\n");
    }

    fs::write(&p, new).map_err(|e| format!("Failed to write target file: {e}"))?;

    Ok(PatchApplyResult {
        ok: true,
        file: target_rel_norm,
        message: "Applied patch".to_string(),
    })
}

#[tauri::command]
async fn ai_chat(
    root: String,
    provider: AiProvider,
    messages: Vec<AiMessage>,
    include_project: bool,
) -> Result<AiChatResult, String> {
    let rootp = PathBuf::from(&root);
    let _canon = rootp
        .canonicalize()
        .map_err(|e| format!("Invalid root: {e}"))?;

    let mut msgs = messages.clone();

    if include_project {
        let ctx = gather_project_text(&rootp, 80, 180_000)?;
        // Prepend as a system message.
        let sys = AiMessage {
            role: "system".to_string(),
            content: format!(
                "You are svAi, an assistant for SystemVerilog projects. Use the provided project context to answer.\n\nWHEN MAKING CODE CHANGES (must follow):\n- Prefer returning a SINGLE fenced ```diff block (unified diff) when editing existing files.\n- If you need to touch MULTIPLE files OR create new files, return ONLY JSON (no markdown):\n  {{\"ops\":[ ... ]}}\n  where each op is one of:\n    - {{\"op\":\"create_file\",\"file\":\"rtl/foo.sv\",\"content\":\"...full file...\"}}\n    - {{\"op\":\"write_file\",\"file\":\"rtl/foo.sv\",\"content\":\"...full file...\"}}  (overwrite)\n    - {{\"op\":\"edit\",\"file\":\"rtl/foo.sv\",\"find\":\"<exact substring>\",\"replace\":\"<replacement>\"}}\n\nDIFF REQUIREMENTS (if you output a diff):\n- Must be a valid unified diff and MUST include BOTH headers:\n  --- a/<relative/path>\n  +++ b/<relative/path>\n- Each hunk MUST start with @@ -old,+new @@ and EVERY line in the hunk MUST start with exactly one of: ' ' (space), '+' or '-'.\n- Include at least 3 lines of unchanged context before/after the change so the patch applies cleanly.\n- Use forward slashes in paths.\n- If you are not changing code, do NOT output a diff.\n\n{}",
                ctx
            ),
        };
        msgs.insert(0, sys);
    }

    let client = reqwest::Client::new();

    let kind = provider.kind.trim().to_lowercase();
    let base = provider.base_url.trim().trim_end_matches('/').to_string();
    let model = provider.model.trim().to_string();

    if kind == "ollama" {
        let url = format!("{}/api/chat", base);
        let body = serde_json::json!({
            "model": model,
            "stream": false,
            "messages": msgs,
        });

        let resp = client
            .post(url)
            .header(CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("AI request failed: {e}"))?;

        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Ok(AiChatResult {
                code: status.as_u16() as i32,
                output: text,
            });
        }

        // Ollama response: { message: { role, content }, ... }
        let v: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
        let content = v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();

        return Ok(AiChatResult {
            code: 0,
            output: content,
        });
    }

    // OpenAI-compatible
    let url = if base.ends_with("/v1") {
        format!("{}/chat/completions", base)
    } else {
        format!("{}/v1/chat/completions", base)
    };

    let body = serde_json::json!({
        "model": model,
        "messages": msgs,
        "temperature": 0.2,
        "stream": false
    });

    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if !provider.api_key.trim().is_empty() {
        let hv = format!("Bearer {}", provider.api_key.trim());
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&hv).map_err(|_| "Bad API key".to_string())?,
        );
    }

    let resp = client
        .post(url)
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("AI request failed: {e}"))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Ok(AiChatResult {
            code: status.as_u16() as i32,
            output: text,
        });
    }

    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
    let content = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c0| c0.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();

    Ok(AiChatResult {
        code: 0,
        output: content,
    })
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

#[allow(dead_code)]
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

fn generate_sim_main_cpp(
    root: &Path,
    top: &str,
    enable_fst: bool,
    max_time: u64,
) -> Result<PathBuf, String> {
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
    let _canon = rootp
        .canonicalize()
        .map_err(|e| format!("Invalid root: {e}"))?;
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
            if ext.eq_ignore_ascii_case("sv")
                || ext.eq_ignore_ascii_case("svh")
                || ext.eq_ignore_ascii_case("v")
            {
                let rel = p
                    .strip_prefix(&rootp)
                    .unwrap_or(p)
                    .to_string_lossy()
                    .to_string();
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
    if ok {
        p
    } else {
        "".to_string()
    }
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
        let _canon = rootp
            .canonicalize()
            .map_err(|e| format!("Invalid root: {e}"))?;
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

        let _enable_fst = cfg.verilator_args.iter().any(|x| x == "--trace-fst")
            || cfg.verilator_args.iter().any(|x| x == "--trace");
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
                if ext.eq_ignore_ascii_case("sv")
                    || ext.eq_ignore_ascii_case("svh")
                    || ext.eq_ignore_ascii_case("v")
                {
                    let rel = p
                        .strip_prefix(&rootp)
                        .unwrap_or(p)
                        .to_string_lossy()
                        .to_string();
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
            return Ok(BuildResult {
                code: vcode,
                output: vout,
                exe_path: "".to_string(),
                waves_path: "".to_string(),
            });
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
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(&mout);

            let mut exe_rel = format!("obj_dir/V{}", top);
            if cfg!(windows) {
                exe_rel.push_str(".exe");
            }
            let waves_rel = ".svlab/waves.fst".to_string();
            return Ok(BuildResult {
                code: mcode,
                output: out.trim().to_string(),
                exe_path: exe_rel,
                waves_path: waves_rel,
            });
        }

        mcmd.arg("-C");
        mcmd.arg("obj_dir");
        mcmd.arg("-f");
        mcmd.arg(&mk);
        mcmd.arg("-j");

        let (mcode, mout) = run_cmd_capture(mcmd)?;
        let mut out = String::new();
        out.push_str(&vout);
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&mout);

        let mut exe_rel = format!("obj_dir/V{}", top);
        if cfg!(windows) {
            exe_rel.push_str(".exe");
        }
        let waves_rel = ".svlab/waves.fst".to_string();

        Ok(BuildResult {
            code: mcode,
            output: out.trim().to_string(),
            exe_path: exe_rel,
            waves_path: waves_rel,
        })
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
fn project_open_waves(
    root: String,
    waves_rel: String,
    gtkwave_path: Option<String>,
) -> Result<(), String> {
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

        cmd.spawn()
            .map_err(|e| format!("Failed to launch GTKWave: {e}"))?;
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
    cmd.spawn()
        .map_err(|e| format!("Failed to launch GTKWave: {e}"))?;
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
                if t.is_empty() {
                    continue;
                }
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
            project_exists,
            project_mkdir,
            project_create_file,
            project_rename,
            project_delete,
            project_lint,
            project_detect_tops,
            project_set_top,
            project_get_config,
            project_set_config,
            project_setup_probe,
            project_setup_apply,
            project_new_create,
            ai_chat,
            project_patch_preview,
            project_apply_patch,
            project_build,
            project_run,
            project_open_waves
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
