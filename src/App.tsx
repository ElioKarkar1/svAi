import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import Editor from "@monaco-editor/react";
import "./App.css";

type FsNode = { path: string; name: string; is_dir: boolean };

type TreeNode = {
  name: string;
  path: string; // relative
  isDir: boolean;
  children: TreeNode[];
};

type ToolchainStatus = {
  verilator_path: string;
  ok: boolean;
  version: string;
  error: string;
  make_path?: string;
  make_ok?: boolean;
  make_version?: string;
  make_error?: string;
  gtkwave_path?: string;
  gtkwave_ok?: boolean;
  gtkwave_version?: string;
  gtkwave_error?: string;
};

type BuildResult = { code: number; output: string; exe_path: string; waves_path: string };

type RunResult = { code: number; output: string };

type TopDetectResult = { candidates: string[]; recommended: string; current: string };

const LS_LAST_ROOT = "svai.lastRoot";
const lsTopKey = (root: string) => `svai.top.${root}`;
const lsExeKey = (root: string) => `svai.exe.${root}`;
const lsWavesKey = (root: string) => `svai.waves.${root}`;

type LintResult = { code: number; output: string };

type BottomTab = "problems" | "terminal" | "ai";

type ActivityTab = "explorer" | "problems" | "terminal" | "ai" | "settings";

type Severity = "error" | "warning";

type Problem = {
  id: string;
  severity: Severity;
  code?: string;
  file: string;
  line: number;
  col?: number;
  message: string;
  raw: string;
};

type RunLog = {
  id: string;
  ts: number;
  title: string;
  cmd?: string;
  code?: number;
  output: string;
};

type CtxMenu = {
  x: number;
  y: number;
  path: string; // relative
  isDir: boolean;
} | null;

type OpenTab = {
  relPath: string;
  title: string;
  language: string;
  dirty: boolean;
  value: string;
};

function detectLanguage(relPath: string): string {
  const lower = relPath.toLowerCase();
  if (lower.endsWith(".sv") || lower.endsWith(".svh") || lower.endsWith(".v")) return "systemverilog";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".f") || lower.endsWith(".txt") || lower.endsWith(".log")) return "plaintext";
  return "plaintext";
}

export default function App() {
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"idle" | "saving" | "building" | "running">("idle");
  const [root, setRoot] = useState<string>("");
  const [nodes, setNodes] = useState<FsNode[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const [toolchain, setToolchain] = useState<ToolchainStatus | null>(null);

  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeRel, setActiveRel] = useState<string>("");

  const [activityTab, setActivityTab] = useState<ActivityTab>("explorer");

  const [bottomTab, setBottomTab] = useState<BottomTab>("terminal");

  const [runs, setRuns] = useState<RunLog[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const LAST_RUN_ID = "__last__";

  const [problems, setProblems] = useState<Problem[]>([]);
  const [lastBuiltExe, setLastBuiltExe] = useState<string>("");
  const [_lastWaves, setLastWaves] = useState<string>("");
  const [topCandidates, setTopCandidates] = useState<string[]>([]);
  const [topValue, setTopValue] = useState<string>("");

  const [cursorLine, setCursorLine] = useState<number>(1);
  const [cursorCol, setCursorCol] = useState<number>(1);

  const editorRef = useRef<any>(null);
  const buildMenuRef = useRef<HTMLDetailsElement | null>(null);
  const projectMenuRef = useRef<HTMLDetailsElement | null>(null);
  const toolsMenuRef = useRef<HTMLDetailsElement | null>(null);

  const [ctxMenu, setCtxMenu] = useState<CtxMenu>(null);

  const problemsText = useMemo(() => {
    if (!root) return "Open a project to see diagnostics.";
    if (problems.length === 0) return "No problems.";
    return `${problems.length} problem(s).`;
  }, [root, problems.length]);

  const activeRun = useMemo(() => (activeRunId ? runs.find((r) => r.id === activeRunId) ?? null : null), [activeRunId, runs]);

  const terminalText = useMemo(() => {
    if (!activeRun) {
      return runs.length ? (runs[0]?.output ?? "") : "";
    }
    return activeRun.output;
  }, [activeRun, runs]);

  const _setLastRun = (r: Omit<RunLog, "id" | "ts"> & { id?: string; ts?: number }) => {
    const item: RunLog = {
      id: LAST_RUN_ID,
      ts: Date.now(),
      title: r.title,
      cmd: r.cmd,
      code: r.code,
      output: r.output,
    };
    setRuns([item]);
    setActiveRunId(item.id);
  };

  const activeTab = useMemo(() => openTabs.find((t) => t.relPath === activeRel) ?? null, [openTabs, activeRel]);

  const nowId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  // Single-slot terminal: always overwrite the last run/log.
  const pushRun = (r: Omit<RunLog, "id" | "ts">) => {
    _setLastRun(r);
    return LAST_RUN_ID;
  };

  const closeMenus = () => {
    if (buildMenuRef.current) buildMenuRef.current.open = false;
    if (projectMenuRef.current) projectMenuRef.current.open = false;
    if (toolsMenuRef.current) toolsMenuRef.current.open = false;
  };

  const refreshToolchain = async () => {
    try {
      const s = (await invoke("toolchain_status")) as ToolchainStatus;
      setToolchain(s);
    } catch (e: any) {
      setToolchain({ verilator_path: "", ok: false, version: "", error: String(e ?? "toolchain check failed") });
    }
  };

  const parseProblemsFromVerilator = (text: string): Problem[] => {
    const out: Problem[] = [];
    const lines = (text || "").replace(/\r\n/g, "\n").split("\n");

    for (const raw of lines) {
      // Examples:
      // %Error-NEEDTIMINGOPT: tb\tb_counter.sv:8:10: message...
      // %Warning-PROCASSINIT: tb\tb_counter.sv:2:15: message...
      const m = raw.match(/^%(Error|Warning)(?:-([A-Z0-9_]+))?:\s+([^:]+):(\d+)(?::(\d+))?:\s+(.*)$/);
      if (!m) continue;
      const sev = m[1] === "Error" ? "error" : "warning";
      const code = m[2] || "";
      const file = (m[3] || "").replace(/\\/g, "/");
      const line = Number(m[4] || 0);
      const col = m[5] ? Number(m[5]) : undefined;
      const message = (m[6] || "").trim();

      out.push({
        id: nowId(),
        severity: sev,
        code: code || undefined,
        file,
        line,
        col,
        message,
        raw,
      });
    }

    return out;
  };

  const refreshTree = async (r: string) => {
    const items = (await invoke("project_list", { root: r })) as FsNode[];
    setNodes(items);

    // Expand top-level dirs by default; merge with persisted state if present.
    const defaults: Record<string, boolean> = {};
    for (const n of items) {
      if (n.is_dir) {
        const p = (n.path || "").replace(/\\/g, "/");
        if (!p.includes("/")) defaults[p] = true;
      }
    }

    let persisted: Record<string, boolean> = {};
    try {
      const raw = localStorage.getItem(`svai.expand.${r}`);
      if (raw) persisted = JSON.parse(raw);
    } catch {
      // ignore
    }

    setExpanded((prev) => ({ ...defaults, ...persisted, ...prev }));
  };

  const loadProject = async (picked: string, announce = true) => {
    if (!picked) return;
    setBusy(true);
    setPhase("idle");
    setBottomTab("terminal");
    try {
      setRoot(picked);
      try {
        localStorage.setItem(LS_LAST_ROOT, picked);
      } catch {
        // ignore
      }

      if (announce) pushRun({ title: "Open Folder", output: `Opened: ${picked}` });

      await refreshTree(picked);
      await refreshToolchain();
      setOpenTabs([]);
      setActiveRel("");
      setSelected("");
      setProblems([]);
      setExpanded({});

      // Restore last exe/waves for this root.
      try {
        const exe = localStorage.getItem(lsExeKey(picked)) || "";
        const w = localStorage.getItem(lsWavesKey(picked)) || "";
        if (exe) setLastBuiltExe(exe);
        if (w) setLastWaves(w);
      } catch {
        // ignore
      }

      // Detect tops and restore last top selection.
      try {
        const t = (await invoke("project_detect_tops", { root: picked })) as TopDetectResult;
        setTopCandidates(t.candidates || []);
        let desired = "";
        try {
          desired = localStorage.getItem(lsTopKey(picked)) || "";
        } catch {
          // ignore
        }
        const chosen = (desired || t.current || t.recommended || "").trim();
        setTopValue(chosen);
        if (announce && !t.current && t.recommended) {
          pushRun({ title: "Top detect", output: `Recommended top: ${t.recommended}` });
        }
      } catch {
        // ignore
      }
    } catch (e: any) {
      pushRun({ title: "Open Folder (error)", output: `Open Project failed: ${String(e ?? "")}` });
    } finally {
      setBusy(false);
      setPhase("idle");
    }
  };

  const openProject = async () => {
    try {
      const sel = await open({ directory: true, multiple: false, title: "Open SystemVerilog project" });
      const picked = typeof sel === "string" ? sel : Array.isArray(sel) ? sel[0] : null;
      if (!picked) return;

      await loadProject(picked, true);
    } catch (e: any) {
      setBottomTab("terminal");
      pushRun({ title: "Open Folder (error)", output: `Open Project failed: ${String(e ?? "")}` });
    }
  };

  const openFile = async (relPath: string) => {
    if (!root) return;
    const normalized = (relPath || "").replace(/\\/g, "/");
    setBusy(true);
    try {
      const existing = openTabs.find((t) => t.relPath === normalized) ?? null;
      if (existing) {
        setActiveRel(normalized);
        return;
      }

      const text = (await invoke("project_read_file", { root, relPath: normalized })) as string;
      const tab: OpenTab = {
        relPath: normalized,
        title: relPath.split("/").slice(-1)[0],
        language: detectLanguage(relPath),
        dirty: false,
        value: text ?? "",
      };
      setOpenTabs((prev) => [...prev, tab]);
      setActiveRel(normalized);
    } catch (e: any) {
      setBottomTab("terminal");
      pushRun({ title: "Open file (error)", output: `Open failed: ${String(e ?? "")}` });
    } finally {
      setBusy(false);
    }
  };

  const closeTab = (relPath: string) => {
    setOpenTabs((prev) => prev.filter((t) => t.relPath !== relPath));
    if (activeRel === relPath) {
      const remaining = openTabs.filter((t) => t.relPath !== relPath);
      setActiveRel(remaining.length ? remaining[remaining.length - 1].relPath : "");
    }
  };

  const saveActive = async () => {
    if (!root || !activeTab) return;
    setBusy(true);
    try {
      await invoke("project_write_file", { root, relPath: activeTab.relPath, content: activeTab.value });
      setOpenTabs((prev) => prev.map((t) => (t.relPath === activeTab.relPath ? { ...t, dirty: false } : t)));
      pushRun({ title: "Save", output: `Saved: ${activeTab.relPath}` });
    } catch (e: any) {
      pushRun({ title: "Save (error)", output: `Save failed: ${String(e ?? "")}` });
    } finally {
      setBusy(false);
    }
  };

  const saveAllDirty = async () => {
    if (!root) return;
    const dirtyTabs = openTabs.filter((t) => t.dirty);
    if (dirtyTabs.length === 0) return;

    setBusy(true);
    setPhase("saving");
    setBottomTab("terminal");
    try {
      for (const t of dirtyTabs) {
        await invoke("project_write_file", { root, relPath: t.relPath, content: t.value });
      }
      setOpenTabs((prev) => prev.map((t) => ({ ...t, dirty: false })));
      pushRun({ title: "Save", output: `Saved ${dirtyTabs.length} file(s)` });
    } catch (e: any) {
      pushRun({ title: "Save (error)", output: `Save failed: ${String(e ?? "")}` });
      throw e;
    } finally {
      setBusy(false);
      setPhase("idle");
    }
  };

  const lint = async () => {
    if (!root) return;
    setBusy(true);
    setBottomTab("terminal");
    try {
      const res = (await invoke("project_lint", {
        root,
        verilatorPath: toolchain?.verilator_path || "",
      })) as LintResult;

      const output = res.output || `(no output) (code ${res.code})`;
      pushRun({ title: `Lint (${res.code === 0 ? "ok" : "issues"})`, cmd: "verilator --lint-only ...", code: res.code, output });
      const ps = parseProblemsFromVerilator(output);
      setProblems(ps);
      if (ps.length) {
        setBottomTab("problems");
      }
    } catch (e: any) {
      const msg = `Lint failed: ${String(e ?? "")}`;
      pushRun({ title: "Lint (error)", cmd: "verilator --lint-only ...", output: msg });
    } finally {
      setBusy(false);
    }
  };

  const jumpTo = async (p: Problem) => {
    if (!root) return;
    await openFile(p.file);
    // Wait a tick for Monaco to mount in case the tab was just opened.
    setTimeout(() => {
      const ed = editorRef.current;
      if (!ed) return;
      const line = Math.max(1, p.line || 1);
      const col = Math.max(1, p.col || 1);
      ed.revealLineInCenter(line);
      ed.setPosition({ lineNumber: line, column: col });
      ed.focus();
    }, 30);
  };

  // Initial toolchain check + restore last project ONCE on startup.
  useEffect(() => {
    void refreshToolchain();

    try {
      const last = localStorage.getItem(LS_LAST_ROOT) || "";
      if (last.trim()) {
        void loadProject(last, false);
      }
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global key handlers (depends on active tab/root for Save).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveActive();
      }
      if (e.key === "Escape") {
        setCtxMenu(null);
      }
    };

    const onClick = () => setCtxMenu(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, root]);

  const isInterestingFile = (p: string) => {
    const lower = (p || "").toLowerCase();
    return lower.endsWith(".sv") || lower.endsWith(".svh") || lower.endsWith(".v") || lower.endsWith(".json") || lower.endsWith(".f");
  };

  const buildTree = (items: FsNode[]): TreeNode => {
    const rootNode: TreeNode = { name: "", path: "", isDir: true, children: [] };

    const ensureChild = (parent: TreeNode, name: string, path: string, isDir: boolean): TreeNode => {
      const existing = parent.children.find((c) => c.name === name && c.isDir === isDir);
      if (existing) return existing;
      const n: TreeNode = { name, path, isDir, children: [] };
      parent.children.push(n);
      return n;
    };

    for (const it of items) {
      const rel = (it.path || "").replace(/\\/g, "/");
      if (!rel) continue;
      const parts = rel.split("/").filter(Boolean);
      if (parts.length === 0) continue;

      // Only include interesting files, but include their parent dirs.
      if (!it.is_dir && !isInterestingFile(rel)) continue;

      let cur = rootNode;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const subPath = parts.slice(0, i + 1).join("/");
        const isLast = i === parts.length - 1;
        const nodeIsDir = isLast ? !!it.is_dir : true;
        cur = ensureChild(cur, part, subPath, nodeIsDir);
      }
    }

    const sortRec = (n: TreeNode) => {
      n.children.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const c of n.children) sortRec(c);
    };
    sortRec(rootNode);

    return rootNode;
  };

  const tree = useMemo(() => buildTree(nodes), [nodes]);

  const toggleExpanded = (p: string) => {
    setExpanded((prev) => {
      const next = { ...prev, [p]: !prev[p] };
      try {
        if (root) localStorage.setItem(`svai.expand.${root}`, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const rootName = useMemo(() => {
    if (!root) return "No folder";
    const parts = root.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] || root;
  }, [root]);

  const crumbs = useMemo(() => {
    if (!root) return "";
    const p = activeTab?.relPath ? activeTab.relPath : "";
    return p ? `${rootName} › ${p}` : rootName;
  }, [root, rootName, activeTab?.relPath]);

  return (
    <div className="app">
      <div className="titlebar">
        <div className="titlebar__left">
          <div className="titlebar__app">svAi{phase !== "idle" ? ` · ${phase}` : ""}</div>
          <div className="titlebar__crumbs">{crumbs || ""}</div>
        </div>
        <div className="titlebar__right">
          <button className="btn btn--primary" onClick={() => void (document.activeElement as any)?.blur?.()} style={{ display: "none" }} />

          <button
            className="btn"
            onClick={() =>
              void (async () => {
                if (!root || !_lastWaves) return;
                try {
                  await invoke("project_open_waves", {
                    root,
                    wavesRel: _lastWaves,
                    gtkwavePath: toolchain?.gtkwave_path || "",
                  });
                } catch (e: any) {
                  pushRun({ title: "Open Waves (error)", output: String(e ?? "") });
                  setBottomTab("terminal");
                }
              })()
            }
            disabled={busy || !root || !_lastWaves || !toolchain?.gtkwave_ok}
            title="Open last waves"
          >
            Waves
          </button>

          <button
            className="btn"
            onClick={() =>
              void (async () => {
                if (!root) return;

                const dirtyCount = openTabs.filter((t) => t.dirty).length;
                if (dirtyCount > 0) {
                  const ok = window.confirm(`You have ${dirtyCount} unsaved file(s).\n\nSave + Build + Run now?`);
                  if (!ok) return;
                  await saveAllDirty();
                }

                // Ensure we have a top set (safe prompt).
                let ensuredTop = (topValue || "").trim();
                try {
                  if (!ensuredTop) {
                    const t = (await invoke("project_detect_tops", { root })) as TopDetectResult;
                    if (t?.candidates?.length) setTopCandidates(t.candidates);
                    const rec = (t?.current || t?.recommended || "").trim();
                    if (rec) {
                      const ok = window.confirm(`Top module isn't set.\n\nSet top to: ${rec}?`);
                      if (!ok) return;
                      await invoke("project_set_top", { root, top: rec });
                      try { localStorage.setItem(lsTopKey(root), rec); } catch {}
                      ensuredTop = rec;
                      setTopValue(rec);
                      pushRun({ title: "Set Top", output: `Top module set to: ${rec}` });
                    } else {
                      pushRun({ title: "Run (error)", output: "Couldn't detect a top module. Use Project ▾ → Top." });
                      return;
                    }
                  }
                } catch (e: any) {
                  pushRun({ title: "Run (error)", output: `Top detect failed: ${String(e ?? "")}` });
                  return;
                }

                setBusy(true);
                setPhase("building");
                setBottomTab("terminal");
                try {
                  const b = (await invoke("project_build", {
                    root,
                    verilatorPath: toolchain?.verilator_path || "",
                    makePath: toolchain?.make_path || "",
                    clean: false,
                  })) as BuildResult;
                  pushRun({ title: `Build (${b.code === 0 ? "ok" : "issues"})`, cmd: "verilator -cc ... && make", code: b.code, output: b.output || "" });
                  setLastBuiltExe(b.exe_path || "");
                  setLastWaves(b.waves_path || "");
                  try {
                    if (b.exe_path) localStorage.setItem(lsExeKey(root), b.exe_path);
                    if (b.waves_path) localStorage.setItem(lsWavesKey(root), b.waves_path);
                  } catch {}
                  const ps = parseProblemsFromVerilator(b.output || "");
                  setProblems(ps);
                  if (ps.length || b.code !== 0) {
                    setBottomTab("problems");
                    return;
                  }
                  const exe = b.exe_path || lastBuiltExe;
                  if (!exe) {
                    pushRun({ title: "Run (error)", output: "No executable produced by build." });
                    return;
                  }
                  setPhase("running");
                  const res = (await invoke("project_run", { root, exeRel: exe })) as RunResult;
                  pushRun({ title: `Run (${res.code === 0 ? "ok" : "exit " + res.code})`, cmd: exe, code: res.code, output: res.output || "" });
                } catch (e: any) {
                  pushRun({ title: "Run (error)", output: String(e ?? "") });
                } finally {
                  setBusy(false);
                  setPhase("idle");
                }
              })()
            }
            disabled={busy || !root}
            title="Build then run"
          >
            Run
          </button>

          <details className="menu" ref={buildMenuRef}>
            <summary className="btn">Build ▾</summary>
            <div className="menu__panel">
              <button
                className="menu__item"
                onClick={() => {
                  closeMenus();
                  void lint();
                }}
                disabled={busy || !root || !toolchain?.ok}
              >
                Lint
              </button>
              <button
                className="menu__item"
                onClick={() =>
                  void (async () => {
                    if (!root) return;
                    const dirtyCount = openTabs.filter((t) => t.dirty).length;
                    if (dirtyCount > 0) {
                      const ok = window.confirm(`You have ${dirtyCount} unsaved file(s).\n\nSave + Build now?`);
                      if (!ok) return;
                      await saveAllDirty();
                    }
                    setBusy(true);
                    setPhase("building");
                    setBottomTab("terminal");
                    try {
                      const res = (await invoke("project_build", {
                        root,
                        verilatorPath: toolchain?.verilator_path || "",
                        makePath: toolchain?.make_path || "",
                        clean: false,
                      })) as BuildResult;
                      pushRun({ title: `Build (${res.code === 0 ? "ok" : "issues"})`, cmd: "verilator -cc ... && make", code: res.code, output: res.output || "" });
                      const ps = parseProblemsFromVerilator(res.output || "");
                      setProblems(ps);
                      if (ps.length) setBottomTab("problems");
                      setLastBuiltExe(res.exe_path || "");
                      setLastWaves(res.waves_path || "");
                      try {
                        if (res.exe_path) localStorage.setItem(lsExeKey(root), res.exe_path);
                        if (res.waves_path) localStorage.setItem(lsWavesKey(root), res.waves_path);
                      } catch {}
                    } catch (e: any) {
                      pushRun({ title: "Build (error)", output: String(e ?? "") });
                    } finally {
                      setBusy(false);
                      setPhase("idle");
                    }
                  })()
                }
                disabled={busy || !root || !toolchain?.ok || !toolchain?.make_ok}
              >
                Build
              </button>
              <button
                className="menu__item"
                onClick={() =>
                  void (async () => {
                    if (!root) return;
                    const ok = window.confirm("Clean build will delete obj_dir and rebuild from scratch. Continue?");
                    if (!ok) return;
                    const dirtyCount = openTabs.filter((t) => t.dirty).length;
                    if (dirtyCount > 0) {
                      const ok2 = window.confirm(`You have ${dirtyCount} unsaved file(s).\n\nSave + Clean Build now?`);
                      if (!ok2) return;
                      await saveAllDirty();
                    }
                    setBusy(true);
                    setPhase("building");
                    setBottomTab("terminal");
                    try {
                      const res = (await invoke("project_build", {
                        root,
                        verilatorPath: toolchain?.verilator_path || "",
                        makePath: toolchain?.make_path || "",
                        clean: true,
                      })) as BuildResult;
                      pushRun({ title: `Clean Build (${res.code === 0 ? "ok" : "issues"})`, cmd: "verilator -cc ... && make (clean)", code: res.code, output: res.output || "" });
                      const ps = parseProblemsFromVerilator(res.output || "");
                      setProblems(ps);
                      if (ps.length) setBottomTab("problems");
                      setLastBuiltExe(res.exe_path || "");
                      setLastWaves(res.waves_path || "");
                      try {
                        if (res.exe_path) localStorage.setItem(lsExeKey(root), res.exe_path);
                        if (res.waves_path) localStorage.setItem(lsWavesKey(root), res.waves_path);
                      } catch {}
                    } catch (e: any) {
                      pushRun({ title: "Clean Build (error)", output: String(e ?? "") });
                    } finally {
                      setBusy(false);
                      setPhase("idle");
                    }
                  })()
                }
                disabled={busy || !root || !toolchain?.ok || !toolchain?.make_ok}
              >
                Clean Build
              </button>
            </div>
          </details>

          <details className="menu" ref={projectMenuRef}>
            <summary className="btn">Project ▾</summary>
            <div className="menu__panel">
              <button
                className="menu__item"
                onClick={() => {
                  closeMenus();
                  void openProject();
                }}
                disabled={busy}
              >
                Open Folder…
              </button>

              <div className="menu__group">
                <div className="menu__label">Top module</div>
                <select
                  className="menu__select"
                  value={topValue}
                  onChange={(e) =>
                    void (async () => {
                      if (!root) return;
                      const nextTop = e.target.value;
                      const dirtyCount = openTabs.filter((t) => t.dirty).length;
                      if (dirtyCount > 0) {
                        const ok = window.confirm(
                          `You have ${dirtyCount} unsaved file(s).\n\nChange top to ${nextTop}?`
                        );
                        if (!ok) return;
                      }
                      setTopValue(nextTop);
                      setBusy(true);
                      try {
                        await invoke("project_set_top", { root, top: nextTop });
                        try { localStorage.setItem(lsTopKey(root), nextTop); } catch {}
                        pushRun({ title: "Set Top", output: `Top module set to: ${nextTop}` });
                        closeMenus();
                      } catch (e: any) {
                        pushRun({ title: "Set Top (error)", output: String(e ?? "") });
                      } finally {
                        setBusy(false);
                        setPhase("idle");
                      }
                    })()
                  }
                  disabled={busy || !root || topCandidates.length === 0}
                >
                  <option value="">(select…)</option>
                  {topCandidates.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>

              <button
                className="menu__item"
                onClick={() => {
                  closeMenus();
                  void saveActive();
                }}
                disabled={busy || !activeTab || !activeTab.dirty}
              >
                Save file
              </button>
              <button
                className="menu__item"
                onClick={() => {
                  closeMenus();
                  void saveAllDirty();
                }}
                disabled={busy || !root || openTabs.filter((t) => t.dirty).length === 0}
              >
                Save all
              </button>
            </div>
          </details>

          <details className="menu" ref={toolsMenuRef}>
            <summary className={"btn pill " + (toolchain?.ok && toolchain?.make_ok ? "pill--ok" : "pill--bad")}>
              Tools ▾
            </summary>
            <div className="menu__panel">
              <div className="menu__kv">
                <div className="menu__k">Verilator</div>
                <div className="menu__v">{toolchain?.ok ? (toolchain?.version || "OK") : (toolchain?.error || "missing")}</div>
                <div className="menu__k">make</div>
                <div className="menu__v">{toolchain?.make_ok ? (toolchain?.make_version || "OK") : (toolchain?.make_error || "missing")}</div>
                <div className="menu__k">GTKWave</div>
                <div className="menu__v">{toolchain?.gtkwave_ok ? (toolchain?.gtkwave_version || "OK") : (toolchain?.gtkwave_error || "missing")}</div>
              </div>
            </div>
          </details>
        </div>
      </div>

      <div className="workarea">
        <aside className="activity">
          <button
            className={"activity__btn " + (activityTab === "explorer" ? "is-active" : "")}
            data-label="Explorer"
            aria-label="Explorer"
            onClick={() => setActivityTab("explorer")}
          >
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M4 6.5h6l2 2H20v9.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6.5Z" stroke="currentColor" strokeWidth="1.6" />
              <path d="M4 6.5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2" stroke="currentColor" strokeWidth="1.6" opacity="0.7"/>
            </svg>
          </button>

          <button
            className={"activity__btn " + (activityTab === "problems" ? "is-active" : "")}
            data-label="Problems"
            aria-label="Problems"
            onClick={() => {
              setActivityTab("problems");
              setBottomTab("problems");
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 3 2.6 20h18.8L12 3Z" stroke="currentColor" strokeWidth="1.6" />
              <path d="M12 9v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
              <path d="M12 17.2h.01" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
            </svg>
          </button>

          <button
            className={"activity__btn " + (activityTab === "terminal" ? "is-active" : "")}
            data-label="Terminal"
            aria-label="Terminal"
            onClick={() => {
              setActivityTab("terminal");
              setBottomTab("terminal");
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M6 7h12M6 12h12M6 17h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
          </button>

          <button
            className={"activity__btn " + (activityTab === "ai" ? "is-active" : "")}
            data-label="AI Assist"
            aria-label="AI Assist"
            onClick={() => {
              setActivityTab("ai");
              setBottomTab("ai");
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M7 12a5 5 0 0 1 10 0v4a3 3 0 0 1-3 3H10a3 3 0 0 1-3-3v-4Z" stroke="currentColor" strokeWidth="1.6" />
              <path d="M9 11V9a3 3 0 0 1 6 0v2" stroke="currentColor" strokeWidth="1.6" opacity="0.8"/>
              <path d="M5.5 12h1.2M17.3 12h1.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
          </button>

          <div style={{ flex: 1 }} />

          <button
            className={"activity__btn " + (activityTab === "settings" ? "is-active" : "")}
            data-label="Settings"
            aria-label="Settings"
            onClick={() => setActivityTab("settings")}
          >
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" stroke="currentColor" strokeWidth="1.6" />
              <path d="M19 12a7 7 0 0 0-.07-.98l2.02-1.57-2-3.46-2.46 1a7.2 7.2 0 0 0-1.7-.98l-.37-2.62H9.58l-.37 2.62c-.6.24-1.17.57-1.7.98l-2.46-1-2 3.46 2.02 1.57A7 7 0 0 0 5 12c0 .33.02.66.07.98L3.05 14.55l2 3.46 2.46-1c.53.41 1.1.74 1.7.98l.37 2.62h4.84l.37-2.62c.6-.24 1.17-.57 1.7-.98l2.46 1 2-3.46-2.02-1.57c.05-.32.07-.65.07-.98Z" stroke="currentColor" strokeWidth="1.2" opacity="0.8"/>
            </svg>
          </button>
        </aside>

        <aside className="sidebar">
          <div className="sidebar__head">
            <div>EXPLORER</div>
            <div className="muted">{root ? rootName : ""}</div>
          </div>

          <div className="sidebar__body">
            {!root ? (
              <div className="empty">
                <div style={{ fontWeight: 650, marginBottom: 6 }}>No folder opened</div>
                <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
                  Open a folder to start browsing and linting SystemVerilog.
                </div>
                <button className="btn" onClick={() => void openProject()} disabled={busy}>
                  Open Folder
                </button>
                {toolchain?.ok ? null : (
                  <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                    {toolchain?.error}
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="sectionTitle">OPEN EDITORS</div>
                {openTabs.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>(none)</div> : null}
                {openTabs.map((t) => (
                  <button
                    key={t.relPath}
                    className={"treeItem " + (t.relPath === activeRel ? "is-selected" : "")}
                    onClick={() => setActiveRel(t.relPath)}
                  >
                    {t.title}{t.dirty ? " *" : ""}
                  </button>
                ))}

                <div className="sectionTitle">FILES</div>
                <div className="fileTree">
                  {(() => {
                    const renderNode = (n: TreeNode, depth: number) => {
                      const pad = 8 + depth * 12;
                      if (n.isDir) {
                        const isOpen = expanded[n.path] ?? false;
                        return (
                          <div key={n.path}>
                            <button
                              className={"treeRow treeRow--dir " + (selected === n.path ? "is-selected" : "")}
                              style={{ paddingLeft: pad }}
                              onClick={() => {
                                setSelected(n.path);
                                toggleExpanded(n.path);
                              }}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                setSelected(n.path);
                                setCtxMenu({ x: e.clientX, y: e.clientY, path: n.path, isDir: true });
                              }}
                            >
                              <span className="chev">{isOpen ? "▾" : "▸"}</span>
                              <span className="treeIcon">📁</span>
                              <span className="treeName">{n.name}</span>
                            </button>
                            {isOpen ? n.children.map((c) => renderNode(c, depth + 1)) : null}
                          </div>
                        );
                      }

                      const lower = n.name.toLowerCase();
                      const icon = lower.endsWith(".sv") || lower.endsWith(".svh") || lower.endsWith(".v") ? "{}" : lower.endsWith(".json") ? "{ }" : lower.endsWith(".f") ? "≡" : "·";
                      return (
                        <button
                          key={n.path}
                          className={"treeRow treeRow--file " + (selected === n.path ? "is-selected" : "")}
                          style={{ paddingLeft: pad + 18 }}
                          onClick={() => {
                            setSelected(n.path);
                            void openFile(n.path);
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setSelected(n.path);
                            setCtxMenu({ x: e.clientX, y: e.clientY, path: n.path, isDir: false });
                          }}
                        >
                          <span className="treeIcon treeIcon--file">{icon}</span>
                          <span className="treeName">{n.name}</span>
                        </button>
                      );
                    };

                    return tree.children.length ? tree.children.map((c) => renderNode(c, 0)) : <div className="muted">(no files)</div>;
                  })()}
                </div>
              </>
            )}
          </div>
        </aside>

        <section className="editor">
          <div className="tabs">
            {openTabs.length === 0 ? <div className="muted" style={{ padding: "6px 10px" }}>Open a file from Explorer.</div> : null}
            {openTabs.map((t) => (
              <div
                key={t.relPath}
                className={"tab " + (t.relPath === activeRel ? "is-active" : "")}
                onClick={() => setActiveRel(t.relPath)}
              >
                <span>{t.title}{t.dirty ? " *" : ""}</span>
                <button
                  className="tab__x"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.relPath);
                  }}
                  title="Close"
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <div style={{ minHeight: 0 }}>
            {activeTab ? (
              <Editor
                theme="vs-dark"
                language={activeTab.language}
                value={activeTab.value}
                onMount={(ed) => {
                  editorRef.current = ed;
                  const pos = ed.getPosition();
                  if (pos) {
                    setCursorLine(pos.lineNumber);
                    setCursorCol(pos.column);
                  }
                  ed.onDidChangeCursorPosition((e) => {
                    setCursorLine(e.position.lineNumber);
                    setCursorCol(e.position.column);
                  });
                }}
                onChange={(val) => {
                  const v = val ?? "";
                  setOpenTabs((prev) =>
                    prev.map((t) =>
                      t.relPath === activeTab.relPath
                        ? { ...t, value: v, dirty: true }
                        : t
                    )
                  );
                }}
                options={{
                  fontSize: 13,
                  minimap: { enabled: false },
                  wordWrap: "on",
                  scrollBeyondLastLine: false,
                  padding: { top: 10 },
                }}
              />
            ) : (
              <div className="panel muted">No file open.</div>
            )}
          </div>
        </section>
      </div>

      <div className="bottom">
        <div className="bottomTabs">
          <button className={"bottomTab " + (bottomTab === "problems" ? "is-active" : "")} onClick={() => setBottomTab("problems")}>
            Problems
          </button>
          <button className={"bottomTab " + (bottomTab === "terminal" ? "is-active" : "")} onClick={() => setBottomTab("terminal")}>
            Terminal
          </button>
          <button className={"bottomTab " + (bottomTab === "ai" ? "is-active" : "")} onClick={() => setBottomTab("ai")}>
            AI Assist
          </button>
        </div>
        <div className="panel">
          {bottomTab === "problems" ? (
            <div className="problems">
              <div className="problems__head">
                <div className="muted">
                  {problems.filter((p) => p.severity === "error").length} error(s) · {problems.filter((p) => p.severity === "warning").length} warning(s)
                </div>
              </div>
              <div className="problems__list">
                {problems.length === 0 ? (
                  <div className="muted">{problemsText}</div>
                ) : (
                  problems.map((p) => (
                    <button
                      key={p.id}
                      className={"problem problem--" + p.severity}
                      onClick={() => void jumpTo(p)}
                      title={p.raw}
                    >
                      <span className={"problem__sev problem__sev--" + p.severity}>{p.severity === "error" ? "×" : "!"}</span>
                      <span className="problem__msg">{p.message}</span>
                      <span className="problem__meta">{p.file}:{p.line}{p.col ? `:${p.col}` : ""}{p.code ? ` · ${p.code}` : ""}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : null}

          {bottomTab === "terminal" ? (
            <div className="terminal">
              <div className="terminal__head">
                {/* Single-slot mode: no run chips/history */}
                <div className="terminal__actions">
                  <button className="btn" onClick={() => { setRuns([]); setActiveRunId(null); }} disabled={busy}>
                    Clear
                  </button>
                  <button
                    className="btn"
                    onClick={() => void navigator.clipboard.writeText(terminalText || "")}
                    disabled={busy || !terminalText}
                  >
                    Copy
                  </button>
                </div>
              </div>
              <pre className="terminal__body">{terminalText || "(no output)"}</pre>
            </div>
          ) : null}

          {bottomTab === "ai" ? <div className="muted">AI integration coming next (local Clawdbot-powered explain/fix).</div> : null}
        </div>
      </div>

      <div className="statusbar">
        <div className="statusbar__left">
          <div className="statusbar__item">{toolchain?.ok ? "Verilator ✓" : "Verilator !"}</div>
          <div className="statusbar__item">
            {problems.filter((p) => p.severity === "error").length}× {problems.filter((p) => p.severity === "warning").length}!
          </div>
          <div className="statusbar__item">{root ? rootName : "No folder"}</div>
        </div>
        <div className="statusbar__right">
          <div className="statusbar__item">Ln {cursorLine}, Col {cursorCol}</div>
        </div>
      </div>

      {ctxMenu ? (
        <div className="ctx" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <button
            className="ctx__item"
            onClick={() => {
              setCtxMenu(null);
              void openFile(ctxMenu.path);
            }}
            disabled={ctxMenu.isDir}
          >
            Open
          </button>

          <div className="ctx__sep" />

          <button
            className="ctx__item"
            onClick={() => {
              const name = window.prompt("New file name (relative to this folder)", ctxMenu.isDir ? `${ctxMenu.path}/new.sv` : "new.sv");
              if (!name) return;
              setCtxMenu(null);
              void (async () => {
                try {
                  await invoke("project_create_file", { root, relPath: name });
                  pushRun({ title: "Create file", output: `Created ${name}` });
                  await refreshTree(root);
                  await openFile(name);
                } catch (e: any) {
                  pushRun({ title: "Create file (error)", output: String(e ?? "") });
                }
              })();
            }}
          >
            New File
          </button>

          <button
            className="ctx__item"
            onClick={() => {
              const name = window.prompt("New folder name (relative)", ctxMenu.isDir ? `${ctxMenu.path}/new_folder` : "new_folder");
              if (!name) return;
              setCtxMenu(null);
              void (async () => {
                try {
                  await invoke("project_mkdir", { root, relPath: name });
                  pushRun({ title: "Create folder", output: `Created ${name}` });
                  await refreshTree(root);
                } catch (e: any) {
                  pushRun({ title: "Create folder (error)", output: String(e ?? "") });
                }
              })();
            }}
          >
            New Folder
          </button>

          <div className="ctx__sep" />

          <button
            className="ctx__item"
            onClick={() => {
              const to = window.prompt("Rename to (relative path)", ctxMenu.path);
              if (!to || to === ctxMenu.path) return;
              setCtxMenu(null);
              void (async () => {
                try {
                  await invoke("project_rename", { root, fromRel: ctxMenu.path, toRel: to });
                  pushRun({ title: "Rename", output: `${ctxMenu.path} → ${to}` });
                  await refreshTree(root);
                } catch (e: any) {
                  pushRun({ title: "Rename (error)", output: String(e ?? "") });
                }
              })();
            }}
          >
            Rename
          </button>

          <button
            className="ctx__item ctx__item--danger"
            onClick={() => {
              const ok = window.confirm(`Delete ${ctxMenu.path}?`);
              if (!ok) return;
              setCtxMenu(null);
              void (async () => {
                try {
                  await invoke("project_delete", { root, relPath: ctxMenu.path });
                  pushRun({ title: "Delete", output: `Deleted ${ctxMenu.path}` });
                  await refreshTree(root);
                } catch (e: any) {
                  pushRun({ title: "Delete (error)", output: String(e ?? "") });
                }
              })();
            }}
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}
