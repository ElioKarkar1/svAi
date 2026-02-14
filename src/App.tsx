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

type ActivityTab = "explorer" | "problems" | "log" | "ai" | "settings";

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

  const [activityTab, setActivityTab] = useState<ActivityTab>("explorer");

  const [bottomTab, setBottomTab] = useState<BottomTab>("log");
  const [logText, setLogText] = useState<string>("");

  const [cursorLine, setCursorLine] = useState<number>(1);
  const [cursorCol, setCursorCol] = useState<number>(1);

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
    try {
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
    } catch (e: any) {
      setBottomTab("log");
      setLogText(`Open Project failed: ${String(e ?? "")}`);
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
          <div className="titlebar__app">svAi</div>
          <div className="titlebar__crumbs">{crumbs || ""}</div>
        </div>
        <div className="titlebar__right">
          <button className="btn" onClick={() => void lint()} disabled={busy || !root || !toolchain?.ok}>
            Lint
          </button>
          <button className="btn" onClick={() => void saveActive()} disabled={busy || !activeTab || !activeTab.dirty}>
            Save
          </button>
          <span className={"pill " + (toolchain?.ok ? "pill--ok" : "pill--bad")}>
            {toolchain?.ok ? `Verilator OK` : "Verilator missing"}
          </span>
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
            className={"activity__btn " + (activityTab === "log" ? "is-active" : "")}
            data-label="Log"
            aria-label="Log"
            onClick={() => {
              setActivityTab("log");
              setBottomTab("log");
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M6 7h12M6 12h12M6 17h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
          </button>

          <button
            className={"activity__btn " + (activityTab === "ai" ? "is-active" : "")}
            data-label="AI"
            aria-label="AI"
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
          <button className={"bottomTab " + (bottomTab === "log" ? "is-active" : "")} onClick={() => setBottomTab("log")}>
            Log
          </button>
          <button className={"bottomTab " + (bottomTab === "ai" ? "is-active" : "")} onClick={() => setBottomTab("ai")}>
            AI
          </button>
        </div>
        <div className="panel">
          {bottomTab === "problems" ? problemsText : null}
          {bottomTab === "log" ? logText : null}
          {bottomTab === "ai" ? <div className="muted">AI integration coming next (local Clawdbot-powered explain/fix).</div> : null}
        </div>
      </div>

      <div className="statusbar">
        <div className="statusbar__left">
          <div className="statusbar__item">{toolchain?.ok ? "Verilator: OK" : "Verilator: missing"}</div>
          <div className="statusbar__item">{root ? `Folder: ${rootName}` : "No folder"}</div>
        </div>
        <div className="statusbar__right">
          <div className="statusbar__item">Ln {cursorLine}, Col {cursorCol}</div>
        </div>
      </div>
    </div>
  );
}
