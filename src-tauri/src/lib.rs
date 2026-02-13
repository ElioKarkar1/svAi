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
}

impl Default for SvlabConfig {
    fn default() -> Self {
        Self {
            top: "".to_string(),
            filelist: "files.f".to_string(),
            include_dirs: vec![],
            defines: vec![],
            verilator_args: vec!["--sv".to_string(), "-Wall".to_string()],
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

fn detect_verilator() -> ToolchainStatus {
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
                };
            }
        }
    }

    ToolchainStatus {
        verilator_path: "".to_string(),
        ok: false,
        version: "".to_string(),
        error: "Verilator not found. Install it (MSYS2 UCRT64) and/or set the path.".to_string(),
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

fn load_or_init_config(root: &Path) -> Result<SvlabConfig, String> {
    let p = root.join(".svlab.json");
    if p.exists() {
        let mut cfg: SvlabConfig = read_json(&p)?;
        if cfg.filelist.trim().is_empty() {
            cfg.filelist = "files.f".to_string();
        }
        if cfg.verilator_args.is_empty() {
            cfg.verilator_args = vec!["--sv".to_string(), "-Wall".to_string()];
        }
        Ok(cfg)
    } else {
        let cfg = SvlabConfig::default();
        write_json(&p, &cfg)?;
        Ok(cfg)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LintResult {
    code: i32,
    output: String,
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

    let mut cmd = Command::new(&vpath);
    cmd.current_dir(&rootp);
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

    // Prefer filelist if present.
    let fl = cfg.filelist.trim();
    let flp = rootp.join(fl);
    if flp.exists() {
        cmd.arg("-f");
        cmd.arg(fl);
    } else {
        // fallback: scan a few dirs
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
            project_lint
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
