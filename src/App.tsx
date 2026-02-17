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
  bash_path?: string;
  bash_ok?: boolean;
  bash_error?: string;
  python_path?: string;
  python_ok?: boolean;
  python_version?: string;
  python_error?: string;
  gpp_path?: string;
  gpp_ok?: boolean;
  gpp_version?: string;
  gpp_error?: string;
};

type BuildResult = { code: number; output: string; exe_path: string; waves_path: string };

type RunResult = { code: number; output: string };

type TopDetectResult = { candidates: string[]; recommended: string; current: string };

type ProjectSetupProbe = {
  has_config: boolean;
  has_filelist: boolean;
  filelist_rel: string;
  has_rtl: boolean;
  has_tb: boolean;
  sv_count: number;
};

type ProjectSetupApplyResult = {
  wrote_config: boolean;
  wrote_filelist: boolean;
  filelist_rel: string;
  created_dirs: string[];
  file_count: number;
};

type ProjectNewResult = {
  root: string;
  created: boolean;
  top: string;
  filelist: string;
  tb: string;
  rtl: string;
};

type AiRole = "system" | "user" | "assistant";

type AiMessage = { role: AiRole; content: string };

type AiProviderKind = "ollama" | "openai_compat";

type AiProvider = {
  kind: AiProviderKind;
  base_url: string;
  model: string;
  api_key?: string;
};

type AiChatResult = { code: number; output: string };

type PatchApplyResult = { ok: boolean; file: string; message: string };

type PatchPreviewResult = { ok: boolean; file: string; start_line: number; after: string; message: string };

type SvlabConfig = {
  top: string;
  filelist: string;
  include_dirs: string[];
  defines: string[];
  verilator_args: string[];
  max_time: number;
  trace: boolean;
  plusargs: string[];
};

const LS_LAST_ROOT = "svai.lastRoot";
const LS_AI_SETTINGS = "svai.ai.settings";
const LS_AI_MESSAGES = "svai.ai.messages";
const lsTopKey = (root: string) => `svai.top.${root}`;
const lsExeKey = (root: string) => `svai.exe.${root}`;
const lsWavesKey = (root: string) => `svai.waves.${root}`;
const lsLastFileKey = (root: string) => `svai.lastFile.${root}`;
const lsCursorKey = (root: string) => `svai.cursor.${root}`;

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
  const [cfg, setCfg] = useState<SvlabConfig | null>(null);
  const [cfgDraft, setCfgDraft] = useState<SvlabConfig | null>(null);
  const [cfgOpen, setCfgOpen] = useState<boolean>(false);
  const [setupOpen, setSetupOpen] = useState<boolean>(false);

  // Project setup wizard (separate from toolchain setup)
  const [projectSetupOpen, setProjectSetupOpen] = useState<boolean>(false);
  const [projectSetupProbe, setProjectSetupProbe] = useState<any>(null);

  const [newProjectOpen, setNewProjectOpen] = useState<boolean>(false);
  const [newProjectParent, setNewProjectParent] = useState<string>("");
  const [newProjectName, setNewProjectName] = useState<string>("svai-project");
  const [newProjectTop, setNewProjectTop] = useState<string>("top");

  const [aiOpen, setAiOpen] = useState<boolean>(false);
  const [aiIncludeProject, setAiIncludeProject] = useState<boolean>(true);
  const [aiProvider, setAiProvider] = useState<AiProvider>({
    kind: "ollama",
    base_url: "http://localhost:11434",
    model: "qwen2.5-coder:7b",
    api_key: "",
  });
  const [aiMessages, setAiMessages] = useState<AiMessage[]>([]);
  const [aiInput, setAiInput] = useState<string>("");
  const [aiPatchOpen, setAiPatchOpen] = useState<boolean>(false);
  const [aiPatchText, setAiPatchText] = useState<string>("");
  const [aiPatchFile, setAiPatchFile] = useState<string>("");

  const [aiInlinePatch, setAiInlinePatch] = useState<{ file: string; line: number; after: string } | null>(null);
  const [aiInlineY, setAiInlineY] = useState<number>(12);
  const [psCreateRtl, setPsCreateRtl] = useState<boolean>(true);
  const [psCreateTb, setPsCreateTb] = useState<boolean>(true);
  const [psWriteFilelist, setPsWriteFilelist] = useState<boolean>(true);
  const [psOverwriteFilelist, setPsOverwriteFilelist] = useState<boolean>(false);

  const [cursorLine, setCursorLine] = useState<number>(1);
  const [cursorCol, setCursorCol] = useState<number>(1);

  const editorRef = useRef<any>(null);
  const aiInlineRef = useRef<{ file: string; line: number; after: string } | null>(null);
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

  // Load AI settings/messages (best-effort)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_AI_SETTINGS);
      if (raw) {
        const s = JSON.parse(raw);
        if (s?.provider) setAiProvider((p) => ({ ...p, ...s.provider }));
        if (typeof s?.includeProject === "boolean") setAiIncludeProject(!!s.includeProject);
      }
    } catch {
      // ignore
    }
    try {
      const raw = localStorage.getItem(LS_AI_MESSAGES);
      if (raw) {
        const m = JSON.parse(raw);
        if (Array.isArray(m)) setAiMessages(m as any);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(LS_AI_SETTINGS, JSON.stringify({ provider: aiProvider, includeProject: aiIncludeProject }));
    } catch {
      // ignore
    }
  }, [aiProvider, aiIncludeProject]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_AI_MESSAGES, JSON.stringify(aiMessages.slice(-60)));
    } catch {
      // ignore
    }
  }, [aiMessages]);

  useEffect(() => {
    aiInlineRef.current = aiInlinePatch;
  }, [aiInlinePatch]);

  // Persist last active file + cursor (best-effort).
  useEffect(() => {
    if (!root) return;
    if (activeRel) {
      try {
        localStorage.setItem(lsLastFileKey(root), activeRel);
      } catch {
        // ignore
      }
    }
    try {
      localStorage.setItem(lsCursorKey(root), JSON.stringify({ line: cursorLine, col: cursorCol }));
    } catch {
      // ignore
    }
  }, [root, activeRel, cursorLine, cursorCol]);

  const tryExtractDiffPatch = (s: string): { patch: string; file: string } | null => {
    const m = (s || "").match(/```diff\s*([\s\S]*?)```/i);
    if (!m) return null;
    const patch = m[1]?.trim() || "";
    if (!patch) return null;
    const fileMatch = patch.match(/^\+\+\+\s+([^\r\n]+)$/m);
    let file = (fileMatch?.[1] || "").trim();
    if (file.startsWith("b/")) file = file.slice(2);
    if (file.startsWith("a/")) file = file.slice(2);
    return { patch, file };
  };

  const tryExtractCodeBlock = (s: string): string | null => {
    // Prefer SV-ish fences, but fall back to any fenced block.
    const ms = (s || "").match(/```(?:systemverilog|verilog|sv|v)?\s*([\s\S]*?)```/i);
    if (!ms) return null;
    const body = (ms[1] || "").replace(/\r\n/g, "\n").trim();
    return body ? body : null;
  };

  const applyAssistantAsFullFile = async (assistantIndex: number) => {
    if (!root) return;
    const assistantText = aiMessages[assistantIndex]?.content || "";

    // Determine target file: prefer diff headers; otherwise fall back to active tab.
    const got = tryExtractDiffPatch(assistantText);
    const targetRel = ((got?.file || activeTab?.relPath || "") as string).replace(/\\/g, "/");
    if (!targetRel) {
      pushRun({ title: "AI", output: "No target file (open a file or include a diff header)." });
      return;
    }

    setBusy(true);
    setBottomTab("terminal");
    try {
      // Ask AI to output the complete updated file.
      const extra: AiMessage = {
        role: "user",
        content:
          `For file ${targetRel}: output the COMPLETE updated file contents ONLY in a single fenced code block. ` +
          `Do not output a diff. Do not add explanations.`,
      };

      const nextMsgs = [...aiMessages, extra];
      setAiMessages(nextMsgs);

      const res = (await invoke("ai_chat", {
        root,
        provider: aiProvider,
        messages: nextMsgs,
        includeProject: aiIncludeProject,
      })) as AiChatResult;

      const reply = (res.output || "").trim();
      setAiMessages((prev) => [...prev, { role: "assistant", content: reply || "(no response)" }]);

      const newFile = tryExtractCodeBlock(reply);
      if (!newFile) {
        pushRun({ title: "AI (error)", output: "AI did not return a fenced code block with full file contents." });
        return;
      }

      await invoke("project_write_file", { root, relPath: targetRel, content: newFile });
      pushRun({ title: "AI edit", output: `Updated: ${targetRel}` });

      // Refresh tree + update open tab if present.
      await refreshTree(root);
      if (openTabs.find((t) => t.relPath === targetRel)) {
        setOpenTabs((prev) => prev.map((t) => (t.relPath === targetRel ? { ...t, value: newFile, dirty: false } : t)));
      }
      setActiveRel(targetRel);
    } catch (e: any) {
      pushRun({ title: "AI edit (error)", output: String(e ?? "") });
    } finally {
      setBusy(false);
    }
  };

  const openPatchPreviewFromAssistant = (assistantText: string) => {
    const got = tryExtractDiffPatch(assistantText);
    if (!got) {
      pushRun({ title: "AI", output: "No ```diff``` patch found in the assistant message." });
      return;
    }

    const normalizedFile = (got.file || "").replace(/\\/g, "/");
    const isOpen = !!openTabs.find((t) => t.relPath === normalizedFile);

    if (root && normalizedFile && isOpen) {
      // Inline preview when file is open
      // Ensure the target file tab is active so the inline bubble is visible.
      setActiveRel(normalizedFile);

      void (async () => {
        try {
          const prev = (await invoke("project_patch_preview", { root, patch: got.patch })) as PatchPreviewResult;
          if (!prev.ok) {
            setBottomTab("terminal");
            pushRun({ title: "Patch preview (error)", output: prev.message || "preview failed" });
            return;
          }
          setAiPatchText(got.patch);
          setAiPatchFile(prev.file || normalizedFile);
          setAiInlinePatch({ file: normalizedFile, line: prev.start_line || 1, after: prev.after || "" });

          // try to scroll to the line and position the bubble under it
          setTimeout(() => {
            const ed = editorRef.current;
            if (!ed) return;
            const ln = prev.start_line || 1;
            ed.revealLineInCenter(ln);
            try {
              const pos = ed.getScrolledVisiblePosition({ lineNumber: ln, column: 1 });
              if (pos && typeof pos.top === "number") {
                setAiInlineY(Math.max(12, Math.floor(pos.top + pos.height + 8)));
              }
            } catch {
              // ignore
            }
          }, 60);
        } catch (e: any) {
          setBottomTab("terminal");
          pushRun({ title: "Patch preview (error)", output: String(e ?? "") });
        }
      })();
      return;
    }

    // Fallback: modal
    setAiPatchText(got.patch);
    setAiPatchFile(got.file);
    setAiPatchOpen(true);
  };

  const applyPatch = async () => {
    if (!root || !aiPatchText.trim()) return;
    setBusy(true);
    setBottomTab("terminal");
    try {
      const res = (await invoke("project_apply_patch", { root, patch: aiPatchText })) as PatchApplyResult;
      pushRun({ title: "Apply patch", output: `${res.message}${res.file ? `\nFile: ${res.file}` : ""}` });
      await refreshTree(root);
      if (res.file) {
        // reload if open
        const normalized = res.file.replace(/\\/g, "/");
        if (openTabs.find((t) => t.relPath === normalized)) {
          try {
            const text = (await invoke("project_read_file", { root, relPath: normalized })) as string;
            setOpenTabs((prev) => prev.map((t) => (t.relPath === normalized ? { ...t, value: text ?? "", dirty: false } : t)));
          } catch {
            // ignore
          }
        }
      }
      setAiPatchOpen(false);
      setAiInlinePatch(null);
    } catch (e: any) {
      pushRun({ title: "Apply patch (error)", output: String(e ?? "") });
    } finally {
      setBusy(false);
    }
  };

  const aiSend = async (text: string) => {
    const content = (text || "").trim();
    if (!content) return;
    if (!root) {
      pushRun({ title: "AI", output: "Open a project first." });
      return;
    }

    const nextMsgs: AiMessage[] = [...aiMessages, { role: "user", content }];
    setAiMessages(nextMsgs);
    setAiInput("");
    setBusy(true);
    setBottomTab("ai");
    try {
      const res = (await invoke("ai_chat", {
        root,
        provider: aiProvider,
        messages: nextMsgs,
        includeProject: aiIncludeProject,
      })) as AiChatResult;

      const reply = (res.output || "").trim() || "(no response)";
      setAiMessages((prev) => [...prev, { role: "assistant", content: reply }]);

      if (res.code !== 0) {
        pushRun({ title: "AI (error)", output: `AI provider returned ${res.code}\n\n${reply}` });
      }
    } catch (e: any) {
      pushRun({ title: "AI (error)", output: String(e ?? "") });
    } finally {
      setBusy(false);
    }
  };

  const refreshToolchain = async () => {
    try {
      const s = (await invoke("toolchain_status")) as ToolchainStatus;
      setToolchain(s);
      // If core tools are missing, open setup helper automatically.
      if (!s?.ok || !s?.make_ok || !s?.bash_ok || !s?.python_ok || !s?.gpp_ok) {
        setSetupOpen(true);
      }
    } catch (e: any) {
      setToolchain({ verilator_path: "", ok: false, version: "", error: String(e ?? "toolchain check failed") });
      setSetupOpen(true);
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

  const openProjectSetupWizard = async (r: string) => {
    if (!r) return;
    try {
      const probe = (await invoke("project_setup_probe", { root: r })) as ProjectSetupProbe;
      setProjectSetupProbe(probe);
      // sensible defaults
      setPsCreateRtl(!probe.has_rtl);
      setPsCreateTb(!probe.has_tb);
      setPsWriteFilelist(!probe.has_filelist);
      setPsOverwriteFilelist(false);

      // Auto-open if missing key project pieces.
      if (!probe.has_filelist || !probe.has_rtl || !probe.has_tb) {
        setProjectSetupOpen(true);
      }
    } catch {
      // ignore
    }
  };

  const applyProjectSetupWizard = async () => {
    if (!root) return;
    setBusy(true);
    setBottomTab("terminal");
    try {
      const res = (await invoke("project_setup_apply", {
        root,
        createRtl: psCreateRtl,
        createTb: psCreateTb,
        writeFilelist: psWriteFilelist,
        overwriteFilelist: psOverwriteFilelist,
        setTop: topValue || null,
      })) as ProjectSetupApplyResult;

      const lines: string[] = [];
      if (res.created_dirs?.length) lines.push(`Created: ${res.created_dirs.join(", ")}`);
      if (res.wrote_filelist) lines.push(`Wrote ${res.filelist_rel} (${res.file_count} file(s))`);
      if (!lines.length) lines.push("No changes.");
      pushRun({ title: "Project setup", output: lines.join("\n") });

      // Refresh state after changes
      await refreshTree(root);
      try {
        const c = (await invoke("project_get_config", { root })) as SvlabConfig;
        setCfg(c);
        setCfgDraft(c);
      } catch {
        // ignore
      }
      try {
        const t = (await invoke("project_detect_tops", { root })) as TopDetectResult;
        setTopCandidates(t.candidates || []);
      } catch {
        // ignore
      }

      setProjectSetupOpen(false);
    } catch (e: any) {
      pushRun({ title: "Project setup (error)", output: String(e ?? "setup failed") });
    } finally {
      setBusy(false);
    }
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
      await openProjectSetupWizard(picked);
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

      // Restore last open file + cursor position.
      try {
        const lastFile = (localStorage.getItem(lsLastFileKey(picked)) || "").trim();
        const curRaw = localStorage.getItem(lsCursorKey(picked)) || "";
        const cur = curRaw ? (JSON.parse(curRaw) as any) : null;
        const line = Math.max(1, Number(cur?.line ?? 1));
        const col = Math.max(1, Number(cur?.col ?? 1));
        if (lastFile) {
          await openFile(lastFile);
          setTimeout(() => {
            const ed = editorRef.current;
            if (!ed) return;
            ed.revealLineInCenter(line);
            ed.setPosition({ lineNumber: line, column: col });
            ed.focus();
          }, 60);
        }
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

      // Load config for editing.
      try {
        const c = (await invoke("project_get_config", { root: picked })) as SvlabConfig;
        setCfg(c);
        setCfgDraft(c);
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

  const openNewProjectModal = async () => {
    closeMenus();
    // Default parent dir: last root's parent if available.
    if (!newProjectParent && root) {
      const parts = root.replace(/\\/g, "/").split("/");
      parts.pop();
      const parentGuess = parts.join("/");
      if (parentGuess) setNewProjectParent(parentGuess);
    }
    setNewProjectOpen(true);
  };

  const chooseNewProjectParent = async () => {
    try {
      const sel = await open({ directory: true, multiple: false, title: "Choose parent folder" });
      const picked = typeof sel === "string" ? sel : Array.isArray(sel) ? sel[0] : null;
      if (!picked) return;
      setNewProjectParent(picked);
    } catch {
      // ignore
    }
  };

  const createNewProject = async () => {
    setBusy(true);
    setBottomTab("terminal");
    try {
      const res = (await invoke("project_new_create", {
        parentDir: newProjectParent,
        name: newProjectName,
        top: newProjectTop,
      })) as ProjectNewResult;

      pushRun({
        title: "New Project",
        output: `Created: ${res.root}\nTop: ${res.top}\nFilelist: ${res.filelist}\nRTL: ${res.rtl}\nTB: ${res.tb}`,
      });

      setNewProjectOpen(false);
      await loadProject(res.root, true);
    } catch (e: any) {
      pushRun({ title: "New Project (error)", output: String(e ?? "") });
    } finally {
      setBusy(false);
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
    <div className={"app" + (aiOpen ? " app--ai" : "")}>
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

              <button
                className="menu__item"
                onClick={() => {
                  void openNewProjectModal();
                }}
                disabled={busy}
              >
                New Project…
              </button>

              <button
                className="menu__item"
                onClick={() => {
                  closeMenus();
                  void openProjectSetupWizard(root);
                  setProjectSetupOpen(true);
                }}
                disabled={busy || !root}
              >
                Setup…
              </button>

              <button
                className="menu__item"
                onClick={() => {
                  closeMenus();
                  setCfgDraft(cfg);
                  setCfgOpen(true);
                }}
                disabled={busy || !root}
              >
                Config…
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
              <button
                className="menu__item"
                onClick={() => {
                  closeMenus();
                  setSetupOpen(true);
                }}
                disabled={busy}
              >
                Setup / Toolchain…
              </button>
              <div className="ctx__sep" />
              <div className="menu__kv">
                <div className="menu__k">Verilator</div>
                <div className="menu__v">{toolchain?.ok ? (toolchain?.version || "OK") : (toolchain?.error || "missing")}</div>
                <div className="menu__k">make</div>
                <div className="menu__v">{toolchain?.make_ok ? (toolchain?.make_version || "OK") : (toolchain?.make_error || "missing")}</div>
                <div className="menu__k">GTKWave</div>
                <div className="menu__v">{toolchain?.gtkwave_ok ? (toolchain?.gtkwave_version || "OK") : (toolchain?.gtkwave_error || "missing")}</div>
                <div className="menu__k">bash</div>
                <div className="menu__v">{toolchain?.bash_ok ? (toolchain?.bash_path || "OK") : (toolchain?.bash_error || "missing")}</div>
                <div className="menu__k">python3</div>
                <div className="menu__v">{toolchain?.python_ok ? (toolchain?.python_version || toolchain?.python_path || "OK") : (toolchain?.python_error || "missing")}</div>
                <div className="menu__k">g++</div>
                <div className="menu__v">{toolchain?.gpp_ok ? (toolchain?.gpp_version || toolchain?.gpp_path || "OK") : (toolchain?.gpp_error || "missing")}</div>
              </div>
            </div>
          </details>
        </div>
      </div>

      {projectSetupOpen ? (
        <div
          className="ctx"
          style={{ left: 80, top: 60, width: 600, maxWidth: "calc(100vw - 100px)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px" }}>
            <div style={{ fontWeight: 700 }}>Project setup</div>
            <button className="btn" onClick={() => setProjectSetupOpen(false)} disabled={busy}>
              Close
            </button>
          </div>
          <div className="ctx__sep" />
          <div style={{ padding: 10, display: "grid", gap: 10 }}>
            <div className="muted">
              Create/repair common project structure and generate a filelist.
            </div>

            {projectSetupProbe ? (
              <div className="menu__kv" style={{ border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, padding: 10 }}>
                <div className="menu__k">rtl/</div>
                <div className="menu__v">{projectSetupProbe.has_rtl ? "found" : "missing"}</div>
                <div className="menu__k">tb/</div>
                <div className="menu__v">{projectSetupProbe.has_tb ? "found" : "missing"}</div>
                <div className="menu__k">filelist</div>
                <div className="menu__v">{projectSetupProbe.has_filelist ? `found (${projectSetupProbe.filelist_rel})` : `missing (${projectSetupProbe.filelist_rel})`}</div>
                <div className="menu__k">SV files</div>
                <div className="menu__v">{projectSetupProbe.sv_count}</div>
              </div>
            ) : (
              <div className="muted">Checking project…</div>
            )}

            <label className="check">
              <input type="checkbox" checked={psCreateRtl} onChange={(e) => setPsCreateRtl(e.target.checked)} />
              Create <code>rtl/</code> (recommended)
            </label>
            <label className="check">
              <input type="checkbox" checked={psCreateTb} onChange={(e) => setPsCreateTb(e.target.checked)} />
              Create <code>tb/</code> (recommended)
            </label>
            <label className="check">
              <input type="checkbox" checked={psWriteFilelist} onChange={(e) => setPsWriteFilelist(e.target.checked)} />
              Generate <code>{(projectSetupProbe?.filelist_rel || "files.f") as string}</code> from source files
            </label>
            <label className="check" style={{ opacity: psWriteFilelist ? 1 : 0.6 }}>
              <input
                type="checkbox"
                checked={psOverwriteFilelist}
                onChange={(e) => setPsOverwriteFilelist(e.target.checked)}
                disabled={!psWriteFilelist}
              />
              Overwrite existing filelist
            </label>

            <div className="muted" style={{ marginTop: 4 }}>
              Tip: pick a top module before you run. You can change it later in Project ▾.
            </div>
            <div className="menu__group">
              <div className="menu__label">Top module</div>
              <select className="menu__select" value={topValue} onChange={(e) => setTopValue(e.target.value)} disabled={busy}>
                <option value="">(select…)</option>
                {topCandidates.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 }}>
              <button className="btn" onClick={() => void openProjectSetupWizard(root)} disabled={busy || !root}>
                Re-scan
              </button>
              <button className="btn primary" onClick={() => void applyProjectSetupWizard()} disabled={busy || !root}>
                Apply
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {newProjectOpen ? (
        <div
          className="ctx"
          style={{ left: 80, top: 60, width: 600, maxWidth: "calc(100vw - 100px)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px" }}>
            <div style={{ fontWeight: 700 }}>New project</div>
            <button className="btn" onClick={() => setNewProjectOpen(false)} disabled={busy}>
              Close
            </button>
          </div>
          <div className="ctx__sep" />
          <div style={{ padding: 10, display: "grid", gap: 10 }}>
            <div className="muted">Creates a new SV project folder with rtl/, tb/, files.f, and .svlab.json.</div>

            <div className="menu__group">
              <div className="menu__label">Location (parent folder)</div>
              <div style={{ display: "flex", gap: 10 }}>
                <input
                  className="menu__select"
                  value={newProjectParent}
                  onChange={(e) => setNewProjectParent(e.target.value)}
                  placeholder="Choose a parent folder…"
                />
                <button className="btn" onClick={() => void chooseNewProjectParent()} disabled={busy}>
                  Browse…
                </button>
              </div>
            </div>

            <div className="menu__group">
              <div className="menu__label">Project name</div>
              <input className="menu__select" value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} />
              <div className="field__hint">Folder name (spaces will be converted to dashes)</div>
            </div>

            <div className="menu__group">
              <div className="menu__label">Top module name</div>
              <input className="menu__select" value={newProjectTop} onChange={(e) => setNewProjectTop(e.target.value)} />
              <div className="field__hint">Will create: rtl/&lt;top&gt;.sv and tb/tb_&lt;top&gt;.sv</div>
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button className="btn primary" onClick={() => void createNewProject()} disabled={busy || !newProjectParent.trim() || !newProjectName.trim() || !newProjectTop.trim()}>
                Create
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {setupOpen ? (
        <div
          className="ctx"
          style={{ left: 80, top: 60, width: 600, maxWidth: "calc(100vw - 100px)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px" }}>
            <div style={{ fontWeight: 700 }}>Toolchain setup</div>
            <button className="btn" onClick={() => setSetupOpen(false)} disabled={busy}>
              Close
            </button>
          </div>
          <div className="ctx__sep" />
          <div style={{ padding: 10, display: "grid", gap: 10 }}>
            <div className="muted">
              svAi uses MSYS2 UCRT64 for Verilator + make + g++ + python3, and GTKWave for viewing waves.
            </div>

            <div className="menu__kv" style={{ border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, padding: 10 }}>
              <div className="menu__k">bash</div>
              <div className="menu__v">{toolchain?.bash_ok ? (toolchain?.bash_path || "OK") : (toolchain?.bash_error || "missing")}</div>
              <div className="menu__k">verilator</div>
              <div className="menu__v">{toolchain?.ok ? (toolchain?.version || toolchain?.verilator_path || "OK") : (toolchain?.error || "missing")}</div>
              <div className="menu__k">make</div>
              <div className="menu__v">{toolchain?.make_ok ? (toolchain?.make_version || toolchain?.make_path || "OK") : (toolchain?.make_error || "missing")}</div>
              <div className="menu__k">g++</div>
              <div className="menu__v">{toolchain?.gpp_ok ? (toolchain?.gpp_version || toolchain?.gpp_path || "OK") : (toolchain?.gpp_error || "missing")}</div>
              <div className="menu__k">python3</div>
              <div className="menu__v">{toolchain?.python_ok ? (toolchain?.python_version || toolchain?.python_path || "OK") : (toolchain?.python_error || "missing")}</div>
              <div className="menu__k">gtkwave</div>
              <div className="menu__v">{toolchain?.gtkwave_ok ? (toolchain?.gtkwave_version || toolchain?.gtkwave_path || "OK") : (toolchain?.gtkwave_error || "missing")}</div>
            </div>

            <div className="muted" style={{ marginTop: 6 }}>
              Install (MSYS2 UCRT64 shell):
            </div>
            <pre className="terminal__body" style={{ margin: 0 }}>
{`pacman -Syu\n
pacman -S --needed \\\n  mingw-w64-ucrt-x86_64-gcc \\\n  mingw-w64-ucrt-x86_64-make \\\n  mingw-w64-ucrt-x86_64-verilator \\\n  python \\\n  mingw-w64-ucrt-x86_64-gtkwave`}
            </pre>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                className="btn"
                onClick={() =>
                  void (async () => {
                    try {
                      await navigator.clipboard.writeText(
                        `pacman -Syu\n\npacman -S --needed \\\n  mingw-w64-ucrt-x86_64-gcc \\\n  mingw-w64-ucrt-x86_64-make \\\n  mingw-w64-ucrt-x86_64-verilator \\\n  python \\\n  mingw-w64-ucrt-x86_64-gtkwave`
                      );
                      pushRun({ title: "Setup", output: "Copied install command to clipboard." });
                    } catch {
                      pushRun({ title: "Setup", output: "Copy failed (clipboard permission)." });
                    }
                  })()
                }
                disabled={busy}
              >
                Copy command
              </button>
              <button
                className="btn"
                onClick={() => {
                  void refreshToolchain();
                }}
                disabled={busy}
              >
                Re-scan
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {cfgOpen && cfgDraft ? (
        <div
          className="ctx"
          style={{ left: 80, top: 60, width: 520, maxWidth: "calc(100vw - 100px)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px" }}>
            <div style={{ fontWeight: 700 }}>Project config</div>
            <button className="btn" onClick={() => setCfgOpen(false)} disabled={busy}>
              Close
            </button>
          </div>
          <div className="ctx__sep" />

          <div style={{ padding: 8, display: "grid", gap: 10 }}>
            <label className="field">
              <div className="field__label">Filelist</div>
              <input
                className="field__input"
                value={cfgDraft.filelist}
                onChange={(e) => setCfgDraft({ ...cfgDraft, filelist: e.target.value })}
              />
              <div className="field__hint">Relative path (default: files.f)</div>
            </label>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label className="field">
                <div className="field__label">Max time (cycles)</div>
                <input
                  className="field__input"
                  value={String(cfgDraft.max_time ?? 0)}
                  onChange={(e) => setCfgDraft({ ...cfgDraft, max_time: Number(e.target.value || 0) })}
                />
              </label>
              <label className="field">
                <div className="field__label">Trace</div>
                <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
                  <input
                    type="checkbox"
                    checked={!!cfgDraft.trace}
                    onChange={(e) => setCfgDraft({ ...cfgDraft, trace: e.target.checked })}
                    id="traceToggle"
                  />
                  <label htmlFor="traceToggle">Enable FST tracing</label>
                </div>
              </label>
            </div>

            <label className="field">
              <div className="field__label">Include dirs (-I)</div>
              <textarea
                className="field__input"
                style={{ height: 70 }}
                value={(cfgDraft.include_dirs || []).join("\n")}
                onChange={(e) => setCfgDraft({ ...cfgDraft, include_dirs: e.target.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) })}
              />
              <div className="field__hint">One per line, relative or absolute</div>
            </label>

            <label className="field">
              <div className="field__label">Defines (-D)</div>
              <textarea
                className="field__input"
                style={{ height: 70 }}
                value={(cfgDraft.defines || []).join("\n")}
                onChange={(e) => setCfgDraft({ ...cfgDraft, defines: e.target.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) })}
              />
              <div className="field__hint">Example: FOO or FOO=1</div>
            </label>

            <label className="field">
              <div className="field__label">Verilator args</div>
              <textarea
                className="field__input"
                style={{ height: 70 }}
                value={(cfgDraft.verilator_args || []).join("\n")}
                onChange={(e) => setCfgDraft({ ...cfgDraft, verilator_args: e.target.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) })}
              />
              <div className="field__hint">One arg per line (e.g. --timing)</div>
            </label>

            <label className="field">
              <div className="field__label">Plusargs (runtime)</div>
              <textarea
                className="field__input"
                style={{ height: 70 }}
                value={(cfgDraft.plusargs || []).join("\n")}
                onChange={(e) => setCfgDraft({ ...cfgDraft, plusargs: e.target.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) })}
              />
              <div className="field__hint">One per line (e.g. +seed=123)</div>
            </label>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                className="btn"
                onClick={() => {
                  setCfgDraft(cfg);
                  setCfgOpen(false);
                }}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="btn"
                onClick={() =>
                  void (async () => {
                    if (!root || !cfgDraft) return;
                    setBusy(true);
                    try {
                      await invoke("project_set_config", { root, cfg: cfgDraft });
                      setCfg(cfgDraft);
                      pushRun({ title: "Config", output: "Saved .svlab.json" });
                      setCfgOpen(false);
                    } catch (e: any) {
                      pushRun({ title: "Config (error)", output: String(e ?? "") });
                      setBottomTab("terminal");
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
                disabled={busy || !root}
              >
                Save config
              </button>
            </div>
          </div>
        </div>
      ) : null}

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
            className={"activity__btn " + (aiOpen ? "is-active" : "")}
            data-label="AI Panel"
            aria-label="AI Panel"
            onClick={() => {
              setAiOpen((v) => !v);
              if (!aiOpen) {
                setActivityTab("ai");
                setBottomTab("ai");
              }
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
              <div style={{ position: "relative", height: "100%" }}>
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
                  ed.onDidScrollChange(() => {
                    const cur = aiInlineRef.current;
                    if (!cur) return;
                    try {
                      const pos = ed.getScrolledVisiblePosition({ lineNumber: cur.line, column: 1 });
                      if (pos && typeof pos.top === "number") {
                        setAiInlineY(Math.max(12, Math.floor(pos.top + pos.height + 8)));
                      }
                    } catch {
                      // ignore
                    }
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

              {aiInlinePatch && activeTab?.relPath === aiInlinePatch.file ? (
                <div
                  className="inlinePatch"
                  style={{
                    position: "absolute",
                    left: 12,
                    top: aiInlineY,
                    right: 12,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                    <div style={{ fontWeight: 800 }}>Suggested change</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="btn" onClick={() => setAiInlinePatch(null)} disabled={busy}>
                        Dismiss
                      </button>
                      <button className="btn primary" onClick={() => void applyPatch()} disabled={busy}>
                        Apply
                      </button>
                    </div>
                  </div>
                  <div className="ctx__sep" style={{ margin: "10px 0" }} />
                  <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                    {aiInlinePatch.file}:{aiInlinePatch.line}
                  </div>
                  <pre className="terminal__body" style={{ margin: 0, maxHeight: 140, overflow: "auto" }}>{aiInlinePatch.after || ""}</pre>
                </div>
              ) : null}
            </div>
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
          <button
            className={"bottomTab " + (aiOpen ? "is-active" : "")}
            onClick={() => {
              setBottomTab("ai");
              setAiOpen((v) => !v);
            }}
          >
            AI
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

          {bottomTab === "ai" ? (
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
              <div className="muted">AI Assist is in the right sidebar.</div>
              <button className="btn" onClick={() => setAiOpen(true)} disabled={busy}>
                Open AI Panel
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className={"aiDock" + (aiOpen ? " is-open" : "")} onClick={(e) => e.stopPropagation()}>
          <div className="aiDock__head">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ fontWeight: 800 }}>AI</div>
              <span className="pill">{aiProvider.kind === "ollama" ? "Local" : "API"}</span>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                className="btn"
                onClick={() => {
                  try {
                    localStorage.removeItem(LS_AI_MESSAGES);
                  } catch {}
                  setAiMessages([]);
                }}
                disabled={busy}
              >
                Clear
              </button>
              <button className="btn" onClick={() => setAiOpen(false)} disabled={busy}>
                Close
              </button>
            </div>
          </div>

          <div className="aiDock__settings">
            <div className="menu__group" style={{ padding: 0 }}>
              <div className="menu__label">Provider</div>
              <select
                className="menu__select"
                value={aiProvider.kind}
                onChange={(e) => setAiProvider((p) => ({ ...p, kind: e.target.value as any }))}
                disabled={busy}
              >
                <option value="ollama">Local (Ollama)</option>
                <option value="openai_compat">OpenAI-compatible</option>
              </select>
            </div>

            <div className="menu__group" style={{ padding: 0 }}>
              <div className="menu__label">Base URL</div>
              <input
                className="menu__select"
                value={aiProvider.base_url}
                onChange={(e) => setAiProvider((p) => ({ ...p, base_url: e.target.value }))}
                disabled={busy}
                placeholder={aiProvider.kind === "ollama" ? "http://localhost:11434" : "http://localhost:1234/v1"}
              />
            </div>

            <div className="menu__group" style={{ padding: 0 }}>
              <div className="menu__label">Model</div>
              <input
                className="menu__select"
                value={aiProvider.model}
                onChange={(e) => setAiProvider((p) => ({ ...p, model: e.target.value }))}
                disabled={busy}
                placeholder={aiProvider.kind === "ollama" ? "qwen2.5-coder:7b" : "model-name"}
              />
            </div>

            {aiProvider.kind === "openai_compat" ? (
              <div className="menu__group" style={{ padding: 0 }}>
                <div className="menu__label">API key</div>
                <input
                  className="menu__select"
                  type="password"
                  value={aiProvider.api_key || ""}
                  onChange={(e) => setAiProvider((p) => ({ ...p, api_key: e.target.value }))}
                  disabled={busy}
                  placeholder="(optional)"
                />
              </div>
            ) : null}

            <label className="check" style={{ marginTop: 6 }}>
              <input
                type="checkbox"
                checked={aiIncludeProject}
                onChange={(e) => setAiIncludeProject(e.target.checked)}
                disabled={busy}
              />
              Include project context (whole project)
            </label>
            <div className="field__hint">svAi reads your project files locally and sends a capped context to the model.</div>
          </div>

          <div className="aiDock__messages">
            {aiMessages.length === 0 ? (
              <div className="muted">Ask for help, or paste an error log.</div>
            ) : (
              aiMessages.map((m, idx) => {
                const patch = m.role === "assistant" ? tryExtractDiffPatch(m.content) : null;
                return (
                  <div key={idx} className={"aiMsg aiMsg--" + m.role}>
                    <div className="aiMsg__role">{m.role}</div>
                    <div className="aiMsg__content">{m.content}</div>
                    {patch ? (
                      <div style={{ display: "flex", gap: 8, marginTop: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                        <button className="btn" onClick={() => openPatchPreviewFromAssistant(m.content)} disabled={busy}>
                          Preview patch
                        </button>
                        <button className="btn primary" onClick={() => void applyAssistantAsFullFile(idx)} disabled={busy || !root}>
                          Apply (full file)
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>

          <div className="aiDock__input">
            <textarea
              className="aiInput"
              value={aiInput}
              onChange={(e) => setAiInput(e.target.value)}
              placeholder={root ? "Ask svAi…" : "Open a project first…"}
              disabled={busy || !root}
              rows={3}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                // Enter sends; Shift+Enter inserts newline
                if (e.shiftKey) return;
                e.preventDefault();
                void aiSend(aiInput);
              }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
              <div className="muted">Enter to send · Shift+Enter for newline</div>
              <button className="btn primary" onClick={() => void aiSend(aiInput)} disabled={busy || !root || !aiInput.trim()}>
                Send
              </button>
            </div>
          </div>
      </div>

      {aiPatchOpen ? (
        <div
          className="ctx"
          style={{ left: 120, top: 80, width: 820, maxWidth: "calc(100vw - 140px)", maxHeight: "calc(100vh - 140px)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px" }}>
            <div style={{ fontWeight: 800 }}>Patch preview {aiPatchFile ? `· ${aiPatchFile}` : ""}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" onClick={() => setAiPatchOpen(false)} disabled={busy}>
                Close
              </button>
              <button className="btn primary" onClick={() => void applyPatch()} disabled={busy || !aiPatchText.trim()}>
                Apply
              </button>
            </div>
          </div>
          <div className="ctx__sep" />
          <pre className="terminal__body" style={{ margin: 0, maxHeight: "calc(100vh - 220px)", overflow: "auto" }}>{aiPatchText}</pre>
        </div>
      ) : null}

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
