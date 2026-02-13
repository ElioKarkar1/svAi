import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import Editor from "@monaco-editor/react";
import "./App.css";

type FsNode = { path: string; name: string; is_dir: boolean };

type ToolchainStatus = {
  verilator_path: string;
  ok: boolean;
  version: string;
  error: string;
};

type LintResult = { code: number; output: string };

type BottomTab = "problems" | "log" | "ai";

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
  const [root, setRoot] = useState<string>("");
  const [nodes, setNodes] = useState<FsNode[]>([]);
  const [selected, setSelected] = useState<string>("");

  const [toolchain, setToolchain] = useState<ToolchainStatus | null>(null);

  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeRel, setActiveRel] = useState<string>("");

  const [bottomTab, setBottomTab] = useState<BottomTab>("log");
  const [logText, setLogText] = useState<string>("");

  // placeholder for parsed problems later
  const problemsText = useMemo(() => {
    const hint = root
      ? "(Problems parser coming next — for now, use Log output.)"
      : "Open a project to see diagnostics.";
    return hint;
  }, [root]);

  const activeTab = useMemo(() => openTabs.find((t) => t.relPath === activeRel) ?? null, [openTabs, activeRel]);

  const refreshToolchain = async () => {
    try {
      const s = (await invoke("toolchain_status")) as ToolchainStatus;
      setToolchain(s);
    } catch (e: any) {
      setToolchain({ verilator_path: "", ok: false, version: "", error: String(e ?? "toolchain check failed") });
    }
  };

  const refreshTree = async (r: string) => {
    const items = (await invoke("project_list", { root: r })) as FsNode[];
    setNodes(items);
  };

  const openProject = async () => {
    const sel = await open({ directory: true, multiple: false, title: "Open SystemVerilog project" });
    const picked = typeof sel === "string" ? sel : Array.isArray(sel) ? sel[0] : null;
    if (!picked) return;

    setBusy(true);
    try {
      setRoot(picked);
      setLogText(`Opened: ${picked}`);
      await refreshTree(picked);
      await refreshToolchain();
      setOpenTabs([]);
      setActiveRel("");
      setSelected("");
    } finally {
      setBusy(false);
    }
  };

  const openFile = async (relPath: string) => {
    if (!root) return;
    setBusy(true);
    try {
      const existing = openTabs.find((t) => t.relPath === relPath) ?? null;
      if (existing) {
        setActiveRel(relPath);
        return;
      }

      const text = (await invoke("project_read_file", { root, relPath })) as string;
      const tab: OpenTab = {
        relPath,
        title: relPath.split("/").slice(-1)[0],
        language: detectLanguage(relPath),
        dirty: false,
        value: text ?? "",
      };
      setOpenTabs((prev) => [...prev, tab]);
      setActiveRel(relPath);
    } catch (e: any) {
      setLogText(`Open failed: ${String(e ?? "")}`);
      setBottomTab("log");
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
      setLogText(`Saved: ${activeTab.relPath}`);
    } catch (e: any) {
      setLogText(`Save failed: ${String(e ?? "")}`);
    } finally {
      setBusy(false);
    }
  };

  const lint = async () => {
    if (!root) return;
    setBusy(true);
    setBottomTab("log");
    try {
      const res = (await invoke("project_lint", {
        root,
        verilatorPath: toolchain?.verilator_path || "",
      })) as LintResult;
      setLogText(res.output || `(no output) (code ${res.code})`);
    } catch (e: any) {
      setLogText(`Lint failed: ${String(e ?? "")}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refreshToolchain();

    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveActive();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, root]);

  return (
    <div className="app">
      <div className="topbar">
        <div className="topbar__left">
          <button className="btn" onClick={() => void openProject()} disabled={busy}>
            Open Project
          </button>
          <button className="btn" onClick={() => void lint()} disabled={busy || !root || !toolchain?.ok}>
            Lint
          </button>
          <button className="btn" onClick={() => void saveActive()} disabled={busy || !activeTab || !activeTab.dirty}>
            Save
          </button>
          <span className="muted">{root ? root : "No project"}</span>
        </div>

        <div className="topbar__right">
          <span className={"pill " + (toolchain?.ok ? "pill--ok" : "pill--bad")}>
            {toolchain?.ok ? `Verilator OK` : "Verilator missing"}
          </span>
          <span className="muted" style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis" }}>
            {toolchain?.ok ? toolchain?.verilator_path : toolchain?.error}
          </span>
        </div>
      </div>

      <div className="main">
        <aside className="sidebar">
          <div className="sidebar__title">Explorer</div>
          {!root ? <div className="muted">Open a project folder.</div> : null}
          {root ? (
            <div>
              {nodes
                .filter((n) => !n.is_dir)
                .filter((n) => {
                  const p = n.path.toLowerCase();
                  return p.endsWith(".sv") || p.endsWith(".svh") || p.endsWith(".v") || p.endsWith(".json") || p.endsWith(".f");
                })
                .map((n) => (
                  <button
                    key={n.path}
                    className={"treeItem " + (selected === n.path ? "is-selected" : "")}
                    onClick={() => {
                      setSelected(n.path);
                      void openFile(n.path);
                    }}
                  >
                    {n.path}
                  </button>
                ))}
            </div>
          ) : null}
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
          <div className={"bottomTab " + (bottomTab === "problems" ? "is-active" : "")} onClick={() => setBottomTab("problems")}>
            Problems
          </div>
          <div className={"bottomTab " + (bottomTab === "log" ? "is-active" : "")} onClick={() => setBottomTab("log")}>
            Log
          </div>
          <div className={"bottomTab " + (bottomTab === "ai" ? "is-active" : "")} onClick={() => setBottomTab("ai")}>
            AI
          </div>
        </div>
        <div className="panel">
          {bottomTab === "problems" ? problemsText : null}
          {bottomTab === "log" ? logText : null}
          {bottomTab === "ai" ? <div className="muted">AI integration coming next (local Clawdbot-powered explain/fix).</div> : null}
        </div>
      </div>
    </div>
  );
}
