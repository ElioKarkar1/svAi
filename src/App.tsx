import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import Editor from "@monaco-editor/react";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
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

type AiFileOp =
  | { op: "create_file"; file: string; content: string }
  | { op: "write_file"; file: string; content: string }
  | { op: "edit"; file: string; find: string; replace: string }
  | { op: "apply_diff"; file: string; patch: string };

// type PatchApplyResult removed (patch flow disabled)

// type PatchPreviewResult removed (patch preview disabled for now)

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

type BottomTab = "problems" | "terminal" | "shell";

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

  const [aiApplyStatus, setAiApplyStatus] = useState<string>("");
  const [aiApplyDetails, setAiApplyDetails] = useState<string>("");

  const [aiReviewOpen, setAiReviewOpen] = useState<boolean>(false);
  const [aiReviewOps, setAiReviewOps] = useState<AiFileOp[]>([]);
  const [aiReviewChecks, setAiReviewChecks] = useState<Record<number, boolean>>({});
  const [aiReviewPreview, setAiReviewPreview] = useState<Record<number, string>>({});
  const [aiReviewTitle, setAiReviewTitle] = useState<string>("");

  // Patch preview/apply flow disabled for now; using full-file apply for reliability.
  const [_aiPatchOpen, _setAiPatchOpen] = useState<boolean>(false);
  const [_aiPatchText, _setAiPatchText] = useState<string>("");
  const [_aiPatchFile, _setAiPatchFile] = useState<string>("");

  const [_aiInlinePatch, _setAiInlinePatch] = useState<{ file: string; line: number; after: string } | null>(null);
  const [_aiInlineY, _setAiInlineY] = useState<number>(12);
  const [psCreateRtl, setPsCreateRtl] = useState<boolean>(true);
  const [psCreateTb, setPsCreateTb] = useState<boolean>(true);
  const [psWriteFilelist, setPsWriteFilelist] = useState<boolean>(true);
  const [psOverwriteFilelist, setPsOverwriteFilelist] = useState<boolean>(false);

  const [cursorLine, setCursorLine] = useState<number>(1);
  const [cursorCol, setCursorCol] = useState<number>(1);

  const editorRef = useRef<any>(null);
  // const _aiInlineRef = useRef<{ file: string; line: number; after: string } | null>(null);

  const termDivRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const termFitRef = useRef<FitAddon | null>(null);
  const termSessionIdRef = useRef<string>("");
  const [termSessionId, setTermSessionId] = useState<string>("");

  const buildMenuRef = useRef<HTMLDetailsElement | null>(null);
  const filesMenuRef = useRef<HTMLDetailsElement | null>(null);
  const projectMenuRef = useRef<HTMLDetailsElement | null>(null);
  const toolsMenuRef = useRef<HTMLDetailsElement | null>(null);

  const [ctxMenu, setCtxMenu] = useState<CtxMenu>(null);
  const [textCtxMenu, setTextCtxMenu] = useState<{ x: number; y: number; kind: "textarea" | "input" } | null>(null);
  const textCtxTargetRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const [dragOverPath, setDragOverPath] = useState<string>("");
  const [dragFromPath, setDragFromPath] = useState<string>("");
  const [dragging, setDragging] = useState<boolean>(false);
  const dragStartRef = useRef<{ x: number; y: number; path: string } | null>(null);

  const [confirmDeletePath, setConfirmDeletePath] = useState<string>("");

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
    if (filesMenuRef.current) filesMenuRef.current.open = false;
    if (projectMenuRef.current) projectMenuRef.current.open = false;
    if (toolsMenuRef.current) toolsMenuRef.current.open = false;
  };

  const closeTextCtxMenu = () => {
    setTextCtxMenu(null);
    textCtxTargetRef.current = null;
  };

  const textCtxDo = async (action: "cut" | "copy" | "paste" | "selectAll") => {
    const el = textCtxTargetRef.current;
    if (!el) return;
    el.focus();

    if (action === "selectAll") {
      el.select();
      return;
    }

    if (action === "copy") {
      try {
        const sel = (el.value || "").slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
        await navigator.clipboard.writeText(sel);
      } catch {
        document.execCommand("copy");
      }
      return;
    }

    if (action === "cut") {
      try {
        const start = el.selectionStart ?? 0;
        const end = el.selectionEnd ?? 0;
        const sel = (el.value || "").slice(start, end);
        await navigator.clipboard.writeText(sel);
        el.setRangeText("", start, end, "start");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } catch {
        document.execCommand("cut");
      }
      return;
    }

    if (action === "paste") {
      try {
        const txt = await navigator.clipboard.readText();
        const start = el.selectionStart ?? 0;
        const end = el.selectionEnd ?? 0;
        el.setRangeText(txt, start, end, "end");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } catch {
        // If clipboard read is blocked, user can still Ctrl+V.
      }
      return;
    }
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragStartRef.current;
      if (!d) return;
      const dx = Math.abs(e.clientX - d.x);
      const dy = Math.abs(e.clientY - d.y);
      if (!dragging && (dx > 4 || dy > 4)) {
        setDragging(true);
        setDragFromPath(d.path);
      }
    };

    const onUp = () => {
      dragStartRef.current = null;
      setDragging(false);
      setDragFromPath("");
      setDragOverPath("");
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

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

  // inline patch preview disabled

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

  const splitUnifiedDiffByFile = (patch: string): { file: string; patch: string }[] => {
    const text = (patch || "").replace(/\r\n/g, "\n");
    const lines = text.split("\n");
    const out: { file: string; patch: string }[] = [];

    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("--- ")) {
        if (start !== -1) {
          const chunk = lines.slice(start, i).join("\n").trim();
          const fm = chunk.match(/^\+\+\+\s+([^\n]+)$/m);
          let file = (fm?.[1] || "").trim();
          if (file.startsWith("b/")) file = file.slice(2);
          if (file.startsWith("a/")) file = file.slice(2);
          if (chunk && file) out.push({ file, patch: chunk });
        }
        start = i;
      }
    }

    if (start !== -1) {
      const chunk = lines.slice(start).join("\n").trim();
      const fm = chunk.match(/^\+\+\+\s+([^\n]+)$/m);
      let file = (fm?.[1] || "").trim();
      if (file.startsWith("b/")) file = file.slice(2);
      if (file.startsWith("a/")) file = file.slice(2);
      if (chunk && file) out.push({ file, patch: chunk });
    }

    return out.length ? out : [];
  };

  const tryExtractCodeBlock = (s: string): string | null => {
    // Prefer SV-ish fences, but fall back to any fenced block.
    const ms = (s || "").match(/```(?:systemverilog|verilog|sv|v)?\s*([\s\S]*?)```/i);
    if (!ms) return null;
    const body = (ms[1] || "").replace(/\r\n/g, "\n").trim();
    return body ? body : null;
  };

  const ensureTrailingNewline = (text: string): string => {
    const t = (text ?? "").replace(/\r\n/g, "\n");
    return t.endsWith("\n") ? t : t + "\n";
  };

  type SvPort = { dir: "input" | "output" | "inout"; name: string; decl: string };

  const [aiJobBusy, setAiJobBusy] = useState<boolean>(false);
  const aiJobIdRef = useRef<string>("");

  const stripSvComments = (s: string): string => {
    const noLine = (s || "").replace(/\/\/.*$/gm, "");
    // naive block comment removal
    return noLine.replace(/\/\*[\s\S]*?\*\//g, "");
  };

  const splitTopLevelCommas = (s: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let depthParen = 0;
    let depthBrack = 0;
    for (const ch of s) {
      if (ch === "(") depthParen++;
      else if (ch === ")") depthParen = Math.max(0, depthParen - 1);
      else if (ch === "[") depthBrack++;
      else if (ch === "]") depthBrack = Math.max(0, depthBrack - 1);
      if (ch === "," && depthParen === 0 && depthBrack === 0) {
        const t = cur.trim();
        if (t) out.push(t);
        cur = "";
        continue;
      }
      cur += ch;
    }
    const t = cur.trim();
    if (t) out.push(t);
    return out;
  };

  const parseModulePorts = (svText: string, moduleName: string): SvPort[] => {
    const txt = stripSvComments((svText || "").replace(/\r\n/g, "\n"));
    const modRe = new RegExp(`\\bmodule\\s+${moduleName}\\b`, "m");
    const m = txt.match(modRe);
    if (!m || m.index == null) return [];
    const after = txt.slice(m.index);

    const findMatchingParen = (s: string, openIdx: number): number => {
      let depth = 0;
      for (let i = openIdx; i < s.length; i++) {
        const ch = s[i];
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) return i;
        }
      }
      return -1;
    };

    // Handle optional parameter list: module name #(...) (...)
    let idx = 0;
    const firstOpen = after.indexOf("(");
    if (firstOpen < 0) return [];

    // If there's a # before the first '(', it's likely `#(...)` params.
    const hashIdx = after.indexOf("#");
    if (hashIdx >= 0 && hashIdx < firstOpen) {
      const paramOpen = after.indexOf("(", hashIdx);
      if (paramOpen >= 0) {
        const paramClose = findMatchingParen(after, paramOpen);
        if (paramClose > paramOpen) {
          idx = after.indexOf("(", paramClose);
        }
      }
    }

    const open = idx > 0 ? idx : firstOpen;
    if (open < 0) return [];
    const close = findMatchingParen(after, open);
    if (close < 0) return [];
    const portBlock = after.slice(open + 1, close);

    const rawItems = splitTopLevelCommas(portBlock);
    const ports: SvPort[] = [];
    let lastDir: "input" | "output" | "inout" | null = null;
    let lastType = "logic";
    let lastRange = "";

    for (const item0 of rawItems) {
      const item = item0.replace(/\s+/g, " ").trim();
      if (!item) continue;

      const dirMatch = item.match(/\b(input|output|inout)\b/);
      if (dirMatch) lastDir = dirMatch[1] as any;

      const rangeMatch = item.match(/\[[^\]]+\]/);
      if (rangeMatch) lastRange = rangeMatch[0];

      const typeMatch = item.match(/\b(logic|wire|reg|bit)\b/);
      if (typeMatch) lastType = typeMatch[1];

      // port name is usually last identifier in the item
      const nameMatch = item.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\)|$)/);
      const name = (nameMatch?.[1] || "").trim();
      const dir = lastDir || (item.includes("output") ? "output" : item.includes("inout") ? "inout" : "input");
      if (!name || name === moduleName) continue;

      // Build a declaration for TB signal.
      const decl = `${lastType} ${lastRange}`.replace(/\s+/g, " ").trim();
      ports.push({ dir, name, decl });
    }

    // de-dupe by name
    const seen = new Set<string>();
    return ports.filter((p) => {
      if (seen.has(p.name)) return false;
      seen.add(p.name);
      return true;
    });
  };

  const genTbFromPorts = (dut: string, ports: SvPort[]): string => {
    const tbName = `tb_${dut}`;
    const lowerNames = ports.map((p) => p.name.toLowerCase());
    const hasClk = lowerNames.includes("clk") || lowerNames.includes("clock");
    const rstName = ports.find((p) => /(rst|reset)/i.test(p.name))?.name;

    const decls = ports
      .map((p) => {
        // declare TB signals as logic
        const base = p.decl || "logic";
        // for outputs, still logic is fine
        return `  ${base} ${p.name};`.replace(/\s+/g, " ");
      })
      .join("\n");

    const assigns: string[] = [];
    if (hasClk) assigns.push("  initial clk = 0;\n  always #5 clk = ~clk;\n");
    if (rstName) assigns.push(`  initial begin\n    ${rstName} = 1'b1;\n    repeat (2) @(posedge ${hasClk ? "clk" : rstName});\n    ${rstName} = 1'b0;\n  end\n`);

    const inst = ports.map((p) => `    .${p.name}(${p.name})`).join(",\n");

    const initStim = ports
      .filter((p) => p.dir === "input" && !/(clk|clock|rst|reset)/i.test(p.name))
      .slice(0, 8)
      .map((p) => `    ${p.name} = '0;`)
      .join("\n");

    const tick = hasClk ? "@(posedge clk)" : "#10";

    const stim =
      `  initial begin\n` +
      `    $display(\"svAi: starting ${tbName}\");\n` +
      (initStim ? initStim + "\n" : "") +
      `    repeat (10) begin\n` +
      `      ${tick};\n` +
      `      // TODO: drive inputs / add checks\n` +
      `    end\n` +
      `    $finish;\n` +
      `  end\n`;

    const body =
      `\`timescale 1ns/1ps\n\n` +
      `module ${tbName}();\n` +
      (decls ? decls + "\n\n" : "") +
      `  ${dut} dut (\n${inst}\n  );\n\n` +
      (assigns.length ? assigns.join("\n") + "\n" : "") +
      stim +
      `endmodule\n`;

    return ensureTrailingNewline(body);
  };

  const looksLikeDiff = (text: string): boolean => {
    const t = (text || "").trim();
    return /^(diff --git |--- |\+\+\+ |@@ )/m.test(t);
  };

  const stripLeadingDiffMarkers = (text: string): string => {
    // If the AI accidentally includes diff prefixes in a "full file" response, strip them.
    // This is intentionally conservative.
    const lines = (text || "").replace(/\r\n/g, "\n").split("\n");
    const out: string[] = [];
    for (const l of lines) {
      if (l.startsWith("diff --git ") || l.startsWith("index ") || l.startsWith("--- ") || l.startsWith("+++ ") || l.startsWith("@@")) {
        continue;
      }
      if (l.startsWith("+")) {
        out.push(l.slice(1));
        continue;
      }
      if (l.startsWith(" ")) {
        out.push(l.slice(1));
        continue;
      }
      // We do NOT strip '-' because that could delete real content.
      out.push(l);
    }
    return out.join("\n").trimEnd();
  };

  const applyAssistantAsFullFile = async (targetRel: string) => {
    if (!root) return;
    if (!targetRel) return;

    // Ask AI to output the complete updated file.
    const extra: AiMessage = {
      role: "user",
      content:
        `For file ${targetRel}: output the COMPLETE updated file contents ONLY in a single fenced code block. ` +
        `Do not output a diff. Do not add explanations.`,
    };

    const messagesForModel = [...aiMessages, extra];

    const res = (await invoke("ai_chat", {
      root,
      provider: aiProvider,
      messages: messagesForModel,
      includeProject: aiIncludeProject,
    })) as AiChatResult;

    const reply = (res.output || "").trim();

    let newFile = tryExtractCodeBlock(reply);
    if (!newFile) {
      throw new Error("AI did not return a fenced code block with full file contents.");
    }

    if (looksLikeDiff(newFile)) {
      // The model ignored instructions and returned a diff; try to strip markers.
      newFile = stripLeadingDiffMarkers(newFile);
    }

    // Last sanity: if it still looks like a diff, bail.
    if (looksLikeDiff(newFile)) {
      throw new Error("AI returned a diff instead of full file contents.");
    }

    await invoke("project_write_file", { root, relPath: targetRel, content: newFile });
    pushRun({ title: "AI edit", output: `Updated: ${targetRel}` });

    // Refresh tree + update open tab if present.
    await refreshTree(root);
    if (openTabs.find((t) => t.relPath === targetRel)) {
      setOpenTabs((prev) => prev.map((t) => (t.relPath === targetRel ? { ...t, value: newFile, dirty: false } : t)));
    }
    setActiveRel(targetRel);
  };

  const tryParseJsonAny = (s: string): any | null => {
    const raw = (s || "").trim();
    // Try fenced json first
    const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
    const candidate = (fenced?.[1] || raw).trim();
    try {
      return JSON.parse(candidate);
    } catch {
      // ignore
    }
    return null;
  };

  const extractAiOps = (v: any): AiFileOp[] | null => {
    if (!v) return null;
    if (Array.isArray(v)) {
      return v.filter((x) => x && typeof x === "object" && typeof x.op === "string") as AiFileOp[];
    }
    if (typeof v === "object") {
      if (Array.isArray((v as any).ops)) {
        return (v as any).ops.filter((x: any) => x && typeof x === "object" && typeof x.op === "string") as AiFileOp[];
      }
      if (typeof (v as any).op === "string") return [v as AiFileOp];
    }
    return null;
  };

  const isBlockedRelPath = (p: string): boolean => {
    const s = (p || "").replace(/\\/g, "/").trim();
    if (!s) return true;
    const lower = s.toLowerCase();
    if (lower.startsWith("/") || lower.includes("://")) return true;
    // no absolute windows paths
    if (/^[a-zA-Z]:\//.test(s) || /^[a-zA-Z]:\\/.test(p || "")) return true;
    const blocked = [".git/", "node_modules/", "dist/", "target/", ".svlab/"];
    return blocked.some((b) => lower.startsWith(b) || lower.includes(`/${b}`));
  };

  const nextSuffixPath = (rel: string, n: number): string => {
    const normalized = rel.replace(/\\/g, "/");
    const parts = normalized.split("/");
    const name = parts.pop() || normalized;
    const dot = name.lastIndexOf(".");
    const base = dot >= 0 ? name.slice(0, dot) : name;
    const ext = dot >= 0 ? name.slice(dot) : "";
    const next = `${base}_${n}${ext}`;
    return [...parts, next].filter(Boolean).join("/");
  };

  const guessCreatePathFromSv = (sv: string): string => {
    const m = (sv || "").match(/\bmodule\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
    const name = (m?.[1] || "").trim();
    return name ? `rtl/${name}.sv` : "rtl/new.sv";
  };

  const getFilelistRel = async (): Promise<string> => {
    // Respect current project config for filelist location.
    let filelistRel = "files.f";
    try {
      const cfg = (await invoke("project_get_config", { root })) as any;
      const fl = (cfg?.filelist || "").toString().trim();
      if (fl) filelistRel = fl;
    } catch {
      // ignore
    }
    return filelistRel;
  };

  const readFilelist = async (filelistRel: string): Promise<string> => {
    try {
      const exists = (await invoke("project_exists", { root, relPath: filelistRel })) as boolean;
      if (!exists) return "";
      return ((await invoke("project_read_file", { root, relPath: filelistRel })) as string) || "";
    } catch {
      return "";
    }
  };

  const normalizeRel = (p: string): string => (p || "").replace(/\\/g, "/").trim().replace(/^\.\//, "");

  const parseFilelistEntries = (text: string): { headerLines: string[]; entries: string[] } => {
    const lines = (text || "").replace(/\r\n/g, "\n").split("\n");
    const headerLines: string[] = [];
    const entries: string[] = [];
    for (const raw of lines) {
      const t = raw.trim();
      if (!t) continue;
      if (t.startsWith("#") || t.startsWith("//")) {
        headerLines.push(raw);
        continue;
      }
      entries.push(normalizeRel(t));
    }
    return { headerLines, entries };
  };

  const writeFilelist = async (filelistRel: string, headerLines: string[], entries: string[]) => {
    const header = headerLines.length
      ? headerLines.join("\n").trimEnd() + "\n\n"
      : "# Autogenerated by svAi\n# Paths are relative to the project root\n\n";
    const body = entries.join("\n") + (entries.length ? "\n" : "");
    await invoke("project_write_file", { root, relPath: filelistRel, content: header + body });
  };

  const maybeUpdateFilelist = async (newRel: string) => {
    if (!root) return;
    const rel = normalizeRel(newRel);
    const lower = rel.toLowerCase();
    if (!(lower.endsWith(".sv") || lower.endsWith(".svh") || lower.endsWith(".v"))) return;

    const filelistRel = await getFilelistRel();
    const text = await readFilelist(filelistRel);
    const { headerLines, entries } = parseFilelistEntries(text);

    const set = new Set(entries.map((e) => e.toLowerCase()));
    if (!set.has(rel.toLowerCase())) {
      entries.push(rel);
    }

    // sort + dedup (case-insensitive)
    const dedupMap = new Map<string, string>();
    for (const e of entries) dedupMap.set(e.toLowerCase(), e);
    const nextEntries = Array.from(dedupMap.values()).sort((a, b) => a.localeCompare(b));

    await writeFilelist(filelistRel, headerLines, nextEntries);
    pushRun({ title: "Project", output: `Updated ${filelistRel} (+${rel})` });
  };

  const maybeRemoveFromFilelist = async (removedRel: string) => {
    if (!root) return;
    const rel = normalizeRel(removedRel);
    if (!rel) return;

    const filelistRel = await getFilelistRel();
    const text = await readFilelist(filelistRel);
    if (!text.trim()) return;

    const { headerLines, entries } = parseFilelistEntries(text);
    const relLower = rel.toLowerCase();
    const nextEntries = entries.filter((e) => {
      const el = e.toLowerCase();
      if (el === relLower) return false;
      if (el.startsWith(relLower + "/")) return false; // folder delete
      return true;
    });

    // Also dedup while we're here.
    const dedupMap = new Map<string, string>();
    for (const e of nextEntries) dedupMap.set(e.toLowerCase(), e);
    const finalEntries = Array.from(dedupMap.values()).sort((a, b) => a.localeCompare(b));

    await writeFilelist(filelistRel, headerLines, finalEntries);
    pushRun({ title: "Project", output: `Updated ${filelistRel} (-${rel})` });
  };

  const createFileFromAssistant = async (assistantIndex: number) => {
    if (!root) return;
    const assistantText = aiMessages[assistantIndex]?.content || "";
    let code = tryExtractCodeBlock(assistantText);
    if (!code) {
      pushRun({ title: "AI", output: "No code block found to create a file from." });
      return;
    }
    code = ensureTrailingNewline(code);
    if (looksLikeDiff(code)) {
      pushRun({ title: "AI", output: "That message looks like a diff. Use Apply instead." });
      return;
    }

    const def = guessCreatePathFromSv(code);
    const rel = (window.prompt("Create file at (relative path)", def) || "").trim().replace(/\\/g, "/");
    if (!rel) return;
    if (isBlockedRelPath(rel)) {
      pushRun({ title: "AI (error)", output: "Refusing to write to that path." });
      return;
    }

    setBusy(true);
    setBottomTab("terminal");
    try {
      const exists = (await invoke("project_exists", { root, relPath: rel })) as boolean;
      let finalPath = rel;
      if (exists) {
        const okOverwrite = window.confirm(`File already exists: ${rel}\n\nOK = overwrite\nCancel = create copy with suffix`);
        if (!okOverwrite) {
          let k = 2;
          while (k < 50) {
            const cand = nextSuffixPath(rel, k);
            const candExists = (await invoke("project_exists", { root, relPath: cand })) as boolean;
            if (!candExists) {
              finalPath = cand;
              break;
            }
            k += 1;
          }
        }
      }

      await invoke("project_write_file", { root, relPath: finalPath, content: code });
      await maybeUpdateFilelist(finalPath);
      pushRun({ title: "AI", output: `Created: ${finalPath}` });
      await refreshTree(root);
      await openFile(finalPath);
    } catch (e: any) {
      pushRun({ title: "AI (error)", output: String(e?.message ?? e ?? "") });
    } finally {
      setBusy(false);
    }
  };

  const openAiReview = async (title: string, ops: AiFileOp[]) => {
    setAiReviewTitle(title);
    setAiReviewOps(ops);
    const checks: Record<number, boolean> = {};
    ops.forEach((_, i) => (checks[i] = true));
    setAiReviewChecks(checks);
    setAiReviewPreview({});
    setAiReviewOpen(true);

    // Build previews best-effort.
    if (!root) return;
    const previews: Record<number, string> = {};
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i] as any;
      const file = (op.file || "").toString().replace(/\\/g, "/");
      try {
        if (op.op === "apply_diff") {
          const exists = (await invoke("project_exists", { root, relPath: file })) as boolean;
          if (exists) {
            const prev = (await invoke("project_patch_preview", { root, patch: op.patch })) as any;
            previews[i] = `Patch preview (${prev.file}:${prev.start_line})\n\n${prev.after}`;
          } else {
            const created = ensureTrailingNewline(stripLeadingDiffMarkers(op.patch || ""));
            previews[i] = `Will create: ${file}\n\n${created}`;
          }
        } else if (op.op === "edit") {
          const cur = (await invoke("project_read_file", { root, relPath: file })) as string;
          const find = (op.find || "").toString();
          const replace = (op.replace || "").toString();
          const hits = find ? cur.split(find).length - 1 : 0;
          previews[i] = `Edit ${file}\nfind hits: ${hits}\n\n--- find ---\n${find}\n\n--- replace ---\n${replace}`;
        } else if (op.op === "create_file" || op.op === "write_file") {
          const exists = (await invoke("project_exists", { root, relPath: file })) as boolean;
          const content = ensureTrailingNewline((op.content || "").toString());
          previews[i] = `${op.op === "create_file" ? "Create" : "Write"} ${file}${exists ? " (overwrites)" : ""}\n\n${content}`;
        }
      } catch (e: any) {
        previews[i] = `Preview error: ${String(e?.message ?? e ?? "")}`;
      }
    }
    setAiReviewPreview(previews);
  };

  const rewriteFileFromPatchViaAi = async (targetRel: string, patchText: string) => {
    if (!root) return;
    const file = (targetRel || "").replace(/\\/g, "/");
    const cur = (await invoke("project_read_file", { root, relPath: file })) as string;

    const prompt =
      `For file ${file}: apply the following unified diff to the CURRENT file contents and output the COMPLETE updated file contents ONLY in a single fenced code block. ` +
      `Do not output a diff. Do not add explanations.\n\n` +
      `CURRENT FILE:\n\n\`\`\`systemverilog\n${cur}\n\`\`\`\n\n` +
      `DIFF:\n\n\`\`\`diff\n${patchText}\n\`\`\`\n`;

    const res = (await invoke("ai_chat", {
      root,
      provider: aiProvider,
      messages: [...aiMessages, { role: "user", content: prompt }],
      includeProject: aiIncludeProject,
    })) as AiChatResult;

    const reply = (res.output || "").trim();
    setAiApplyDetails(reply);

    let newFile = tryExtractCodeBlock(reply);
    if (!newFile) throw new Error("AI rewrite did not return a code block.");
    if (looksLikeDiff(newFile)) {
      newFile = stripLeadingDiffMarkers(newFile);
    }
    if (looksLikeDiff(newFile)) throw new Error("AI rewrite returned a diff.");

    newFile = ensureTrailingNewline(newFile);
    await invoke("project_write_file", { root, relPath: file, content: newFile });

    // Update open tabs if needed
    if (openTabs.find((t) => t.relPath === file)) {
      setOpenTabs((prev) => prev.map((t) => (t.relPath === file ? { ...t, value: newFile, dirty: false } : t)));
    }
  };

  const applyOpsDirect = async (
    ops: AiFileOp[],
    opts?: { allowCreateSuffixPrompt?: boolean; defaultOverwrite?: boolean; title?: string }
  ) => {
    if (!root) return;
    const allowCreateSuffixPrompt = opts?.allowCreateSuffixPrompt ?? true;
    const defaultOverwrite = opts?.defaultOverwrite ?? false;

    setBusy(true);
    setBottomTab("terminal");
    try {
      for (let i = 0; i < ops.length; i++) {
        const anyOp: any = ops[i] as any;
        const file = (anyOp.file || "").toString().replace(/\\/g, "/");
        if (!file || isBlockedRelPath(file)) throw new Error(`Invalid/blocked path: ${file}`);

        if (anyOp.op === "apply_diff") {
          const exists = (await invoke("project_exists", { root, relPath: file })) as boolean;
          if (exists) {
            try {
              await invoke("project_apply_patch", { root, patch: anyOp.patch });
              pushRun({ title: opts?.title || "AI", output: `Patched: ${file}` });
            } catch (e: any) {
              // Fallback: ask AI for a full-file rewrite and write it.
              pushRun({ title: opts?.title || "AI", output: `Patch failed; rewriting full file: ${file}` });
              await rewriteFileFromPatchViaAi(file, anyOp.patch || "");
              pushRun({ title: opts?.title || "AI", output: `Rewrote: ${file}` });
            }
          } else {
            let content = stripLeadingDiffMarkers(anyOp.patch || "");
            content = ensureTrailingNewline(content);
            await invoke("project_write_file", { root, relPath: file, content });
            await maybeUpdateFilelist(file);
            pushRun({ title: opts?.title || "AI", output: `Created: ${file}` });
          }
          continue;
        }

        if (anyOp.op === "edit") {
          const current = (await invoke("project_read_file", { root, relPath: file })) as string;
          const find = (anyOp.find || "").toString();
          const replace = (anyOp.replace || "").toString();
          const hits = find ? current.split(find).length - 1 : 0;
          if (hits !== 1) throw new Error(`Edit did not apply cleanly (find hits=${hits}) in ${file}`);
          const updated = current.replace(find, replace);
          await invoke("project_write_file", { root, relPath: file, content: updated });
          pushRun({ title: opts?.title || "AI", output: `Patched: ${file}` });
          continue;
        }

        if (anyOp.op === "create_file" || anyOp.op === "write_file") {
          let content = (anyOp.content || "").toString();
          if (!content.trim()) throw new Error(`Missing content for ${file}`);
          content = ensureTrailingNewline(content);

          const exists = (await invoke("project_exists", { root, relPath: file })) as boolean;
          let finalPath = file;

          if (exists && anyOp.op === "create_file") {
            if (defaultOverwrite) {
              // leave finalPath as-is
            } else if (allowCreateSuffixPrompt) {
              const okOverwrite = window.confirm(`File already exists: ${file}\n\nOK = overwrite\nCancel = create copy with suffix`);
              if (!okOverwrite) {
                let k = 2;
                while (k < 50) {
                  const cand = nextSuffixPath(file, k);
                  const candExists = (await invoke("project_exists", { root, relPath: cand })) as boolean;
                  if (!candExists) {
                    finalPath = cand;
                    break;
                  }
                  k += 1;
                }
              }
            }
          }

          await invoke("project_write_file", { root, relPath: finalPath, content });
          await maybeUpdateFilelist(finalPath);
          pushRun({ title: opts?.title || "AI", output: `${exists ? "Wrote" : "Created"}: ${finalPath}` });
          continue;
        }

        pushRun({ title: opts?.title || "AI", output: `Skipped unknown op at index ${i}` });
      }

      await refreshTree(root);
    } catch (e: any) {
      pushRun({ title: `${opts?.title || "AI"} (error)`, output: String(e?.message ?? e ?? "") });
    } finally {
      setBusy(false);
    }
  };

  const applyAiOps = async () => {
    if (!root) return;
    const selected = aiReviewOps
      .map((op, i) => ({ op, i }))
      .filter(({ i }) => aiReviewChecks[i])
      .map(({ op }) => op);
    if (selected.length === 0) {
      setAiReviewOpen(false);
      return;
    }

    await applyOpsDirect(selected, { title: "AI" });
    setAiReviewOpen(false);
  };

  const applyAssistantAuto = async (assistantIndex: number) => {
    if (!root) return;

    const assistantText = aiMessages[assistantIndex]?.content || "";

    // JSON ops (preferred for multi-file changes)
    const parsed = tryParseJsonAny(assistantText);
    const opsFromJson = extractAiOps(parsed);
    if (opsFromJson && opsFromJson.length) {
      await openAiReview(`AI ops (${opsFromJson.length})`, opsFromJson);
      return;
    }

    // Otherwise: diff apply flow (open a preview/review first)
    const got = tryExtractDiffPatch(assistantText);
    if (got?.patch) {
      const chunks = splitUnifiedDiffByFile(got.patch);
      const ops: AiFileOp[] = (chunks.length ? chunks : [{ file: got.file, patch: got.patch }]).map((c) => ({
        op: "apply_diff",
        file: (c.file || "").replace(/\\/g, "/"),
        patch: c.patch,
      }));
      if (ops.length) {
        await openAiReview(`Diff (${ops.length} file${ops.length === 1 ? "" : "s"})`, ops);
        return;
      }
    }

    const targetRel = ((got?.file || activeTab?.relPath || "") as string).replace(/\\/g, "/");
    if (!targetRel) {
      pushRun({ title: "AI", output: "No target file (open a file first)." });
      return;
    }

    setBusy(true);
    setBottomTab("terminal");
    try {
      // 1) Try a deterministic snippet edit first.
      const current = (await invoke("project_read_file", { root, relPath: targetRel })) as string;

      const editReq: AiMessage = {
        role: "user",
        content:
          `Return ONLY JSON for a small edit to ${targetRel}. ` +
          `Schema: {"file":"${targetRel}","find":"<exact substring>","replace":"<replacement>"}. ` +
          `The find string must appear exactly once in the current file. No markdown, no explanation.`,
      };

      const messagesForModel = [...aiMessages, editReq];

      setAiApplyStatus(`Applying patch… (${targetRel})`);
      setAiApplyDetails("");

      const res = (await invoke("ai_chat", {
        root,
        provider: aiProvider,
        messages: messagesForModel,
        includeProject: aiIncludeProject,
      })) as AiChatResult;

      const reply = (res.output || "").trim();
      setAiApplyDetails(reply);

      const obj = tryParseJsonAny(reply);
      const find = (obj?.find || "").toString();
      const replace = (obj?.replace || "").toString();

      if (find && typeof replace === "string") {
        const hits = current.split(find).length - 1;
        if (hits === 1) {
          const updated = current.replace(find, replace);
          await invoke("project_write_file", { root, relPath: targetRel, content: updated });
          pushRun({ title: "AI edit", output: `Patched: ${targetRel}` });
          setAiApplyStatus(`Patched: ${targetRel}`);
          setAiMessages((prev) => [...prev, { role: "assistant", content: `Applied patch to ${targetRel}.` }]);
          await refreshTree(root);
          if (openTabs.find((t) => t.relPath === targetRel)) {
            setOpenTabs((prev) => prev.map((t) => (t.relPath === targetRel ? { ...t, value: updated, dirty: false } : t)));
          }
          setActiveRel(targetRel);
          return;
        }
      }

      // 2) Fallback: rewrite full file.
      pushRun({ title: "AI edit", output: "Patch failed; falling back to full-file rewrite…" });
      setAiApplyStatus(`Patch failed; rewriting full file… (${targetRel})`);
      await applyAssistantAsFullFile(targetRel);
      setAiApplyStatus(`Updated: ${targetRel}`);
      setAiMessages((prev) => [...prev, { role: "assistant", content: `Updated ${targetRel}.` }]);
    } catch (e: any) {
      const msg = String(e?.message ?? e ?? "");
      pushRun({ title: "AI edit (error)", output: msg });
      setAiApplyStatus(`Error: ${msg}`);
      setAiMessages((prev) => [...prev, { role: "assistant", content: `Edit failed: ${msg}` }]);
    } finally {
      setBusy(false);
    }
  };

  // Patch preview flow is currently disabled (too flaky with local models).
  // We'll re-enable after we generate patches ourselves.

  // Patch apply flow disabled for now (local models are too flaky producing valid hunks).

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
    setAiJobBusy(true);
    setAiOpen(true);
    setBottomTab("terminal");
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
      setAiJobBusy(false);
    }
  };

  const startShell = async () => {
    if (!root) return;
    if (termSessionIdRef.current) return;

    // Create terminal instance if needed
    if (!termRef.current) {
      const t = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        convertEol: true,
        scrollback: 5000,
      });
      const fit = new FitAddon();
      t.loadAddon(fit);
      termRef.current = t;
      termFitRef.current = fit;

      if (termDivRef.current) {
        t.open(termDivRef.current);
        try {
          fit.fit();
        } catch {}
      }

      t.onData((data) => {
        const sid = termSessionIdRef.current;
        if (!sid) return;
        void invoke("term_write", { id: sid, data });
      });
    }

    // Start backend PTY
    const cols = termRef.current?.cols || 80;
    const rows = termRef.current?.rows || 24;
    const sid = (await invoke("term_start", { root, cols, rows })) as string;
    termSessionIdRef.current = sid;
    setTermSessionId(sid);

    termRef.current?.writeln(`\x1b[90m[shell started: ${sid}]\x1b[0m`);
  };

  const stopShell = async () => {
    const sid = termSessionIdRef.current;
    if (!sid) return;
    termSessionIdRef.current = "";
    setTermSessionId("");
    try {
      await invoke("term_kill", { id: sid });
    } catch {}
    termRef.current?.writeln(`\r\n\x1b[90m[shell stopped]\x1b[0m`);
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

  const refreshTops = async (r?: string) => {
    const rr = (r || root || "").trim();
    if (!rr) return;
    try {
      const t = (await invoke("project_detect_tops", { root: rr })) as TopDetectResult;
      setTopCandidates(t.candidates || []);
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
      await refreshTops(root);

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

  const saveTabByRel = async (relPath: string) => {
    if (!root) return;
    const p = (relPath || "").replace(/\\/g, "/");
    const t = openTabs.find((x) => x.relPath === p);
    if (!t) {
      pushRun({ title: "Save", output: `Not open: ${p}` });
      return;
    }
    if (!t.dirty) {
      pushRun({ title: "Save", output: `No changes: ${p}` });
      return;
    }
    try {
      setBusy(true);
      setPhase("saving");
      await invoke("project_write_file", { root, relPath: p, content: t.value });
      setOpenTabs((prev) => prev.map((x) => (x.relPath === p ? { ...x, dirty: false } : x)));
      pushRun({ title: "Save", output: `Saved ${p}` });
    } catch (e: any) {
      pushRun({ title: "Save (error)", output: String(e ?? "") });
    } finally {
      setPhase("idle");
      setBusy(false);
    }
  };

  const saveActive = async () => {
    if (!root || !activeTab) return;
    await saveTabByRel(activeTab.relPath);
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
        closeTextCtxMenu();
        setConfirmDeletePath("");
        closeMenus();
      }
    };

    const onClick = (ev: MouseEvent) => {
      setCtxMenu(null);
      closeTextCtxMenu();

      // Click outside any open top menu closes it.
      const t = ev.target as any;
      const inMenu =
        (buildMenuRef.current && buildMenuRef.current.contains(t)) ||
        (filesMenuRef.current && filesMenuRef.current.contains(t)) ||
        (projectMenuRef.current && projectMenuRef.current.contains(t)) ||
        (toolsMenuRef.current && toolsMenuRef.current.contains(t));
      if (!inMenu) closeMenus();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, root]);

  // Shell terminal event wiring + resize.
  useEffect(() => {
    let unlisten: null | (() => void) = null;
    void (async () => {
      unlisten = await listen<{ id: string; data: string }>("term:data", (e) => {
        const sid = termSessionIdRef.current;
        if (!sid) return;
        if (e.payload?.id !== sid) return;
        termRef.current?.write(e.payload.data);
      });
    })();

    const onResize = () => {
      if (!termRef.current || !termFitRef.current) return;
      try {
        termFitRef.current.fit();
      } catch {}
      const sid = termSessionIdRef.current;
      if (!sid) return;
      void invoke("term_resize", { id: sid, cols: termRef.current.cols, rows: termRef.current.rows });
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      try {
        if (unlisten) unlisten();
      } catch {}
    };
  }, []);

  const isInterestingFile = (p: string) => {
    const lower = (p || "").toLowerCase();
    return lower.endsWith(".sv") || lower.endsWith(".svh") || lower.endsWith(".v") || lower.endsWith(".json") || lower.endsWith(".f");
  };

  const baseName = (p: string): string => {
    const s = (p || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const parts = s.split("/").filter(Boolean);
    return parts[parts.length - 1] || "";
  };

  const isSubpath = (parent: string, child: string): boolean => {
    const p = (parent || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const c = (child || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!p || !c) return false;
    return c === p || c.startsWith(p + "/");
  };

  const moveTreePath = async (fromRel: string, toDirRel: string) => {
    if (!root) return;
    const from = (fromRel || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
    const toDir = (toDirRel || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
    if (!from || !toDir) return;
    if (isBlockedRelPath(from) || isBlockedRelPath(toDir)) {
      pushRun({ title: "Move", output: "Refusing to move blocked paths." });
      return;
    }
    // Don't allow moving a folder into itself (or its children)
    if (isSubpath(from, toDir)) {
      pushRun({ title: "Move", output: "Can't move a folder into itself." });
      return;
    }

    const name = baseName(from);
    if (!name) return;
    const to = `${toDir}/${name}`.replace(/\/+/, "/");
    if (to === from) return;

    setBusy(true);
    setBottomTab("terminal");
    try {
      await invoke("project_rename", { root, fromRel: from, toRel: to });
      pushRun({ title: "Move", output: `${from} → ${to}` });

      // Update open tabs paths (file or directory move)
      setOpenTabs((prev) =>
        prev.map((t) => {
          const rp = t.relPath;
          if (rp === from) return { ...t, relPath: to, title: baseName(to) };
          if (rp.startsWith(from + "/")) {
            const next = to + rp.slice(from.length);
            return { ...t, relPath: next, title: baseName(next) };
          }
          return t;
        })
      );
      setActiveRel((prev) => {
        if (prev === from) return to;
        if (prev.startsWith(from + "/")) return to + prev.slice(from.length);
        return prev;
      });
      setSelected((prev) => {
        if (prev === from) return to;
        if (prev.startsWith(from + "/")) return to + prev.slice(from.length);
        return prev;
      });

      await refreshTree(root);
    } catch (e: any) {
      pushRun({ title: "Move (error)", output: String(e?.message ?? e ?? "") });
    } finally {
      setBusy(false);
      setDragOverPath("");
    }
  };

  const deletePath = async (targetRel: string) => {
    if (!root) return;
    const target = (targetRel || "").replace(/\\/g, "/");
    if (!target) return;
    setBusy(true);
    setBottomTab("terminal");
    try {
      await invoke("project_delete", { root, relPath: target });
      pushRun({ title: "Delete", output: `Deleted ${target}` });

      await maybeRemoveFromFilelist(target);

      const curActive = activeRel;
      setOpenTabs((prev) => {
        const remaining = prev.filter((t) => !(t.relPath === target || t.relPath.startsWith(target + "/")));
        if (curActive === target || curActive.startsWith(target + "/")) {
          setActiveRel(remaining[0]?.relPath || "");
        }
        return remaining;
      });

      await refreshTree(root);
    } catch (e: any) {
      pushRun({ title: "Delete (error)", output: String(e?.message ?? e ?? "") });
    } finally {
      setBusy(false);
    }
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

          <details
            className="menu"
            ref={buildMenuRef}
            onToggle={() => {
              if (!buildMenuRef.current?.open) return;
              if (filesMenuRef.current) filesMenuRef.current.open = false;
              if (projectMenuRef.current) projectMenuRef.current.open = false;
              if (toolsMenuRef.current) toolsMenuRef.current.open = false;
            }}
          >
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

          <details
            className="menu"
            ref={filesMenuRef}
            onToggle={() => {
              if (!filesMenuRef.current?.open) return;
              if (buildMenuRef.current) buildMenuRef.current.open = false;
              if (projectMenuRef.current) projectMenuRef.current.open = false;
              if (toolsMenuRef.current) toolsMenuRef.current.open = false;
            }}
          >
            <summary className="btn">Files ▾</summary>
            <div className="menu__panel">
              <button
                className="menu__item"
                onClick={() => {
                  closeMenus();
                  void saveActive();
                }}
                disabled={busy || !activeTab || !activeTab.dirty}
              >
                Save
              </button>
              <button
                className="menu__item"
                onClick={() => {
                  closeMenus();
                  void saveAllDirty();
                }}
                disabled={busy || !root || openTabs.filter((t) => t.dirty).length === 0}
              >
                Save All
              </button>
              <div className="ctx__sep" />

              <button
                className="menu__item"
                onClick={() => {
                  closeMenus();
                  void (async () => {
                    if (!root) return;
                    const name = (window.prompt("Module name (optional)", "") || "").trim();
                    const spec = (window.prompt("Describe what to build (module + optional testbench)", "") || "").trim();
                    if (!spec) return;

                    const hint = name
                      ? `Target module name: ${name}. Prefer rtl/${name}.sv and tb/tb_${name}.sv if generating a testbench.`
                      : "Choose appropriate rtl/ and tb/ paths.";

                    const content =
                      `Create a SystemVerilog module (and optionally a testbench) based on this spec:\n\n${spec}\n\n${hint}\n\n` +
                      `Return ONLY JSON {\"ops\":[...]} using create_file/write_file/edit. Include complete file contents in content fields.`;

                    await aiSend(content);
                  })();
                }}
                disabled={busy || !root}
              >
                Create Module…
              </button>

              <button
                className="menu__item"
                onClick={() => {
                  const name = window.prompt("New file name (relative)", "rtl/new.sv");
                  if (!name) return;
                  closeMenus();
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
                disabled={busy || !root}
              >
                New File…
              </button>

              <button
                className="menu__item"
                onClick={() => {
                  closeMenus();
                  void (async () => {
                    if (!root) return;
                    const guess = (() => {
                      const txt = activeTab?.value || "";
                      const m = txt.match(/\bmodule\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
                      return (m?.[1] || "").trim() || "top";
                    })();
                    const dut = (window.prompt("DUT module name", guess) || "").trim();
                    if (!dut) return;
                    const tbName = `tb_${dut}`;
                    let rel = `tb/${tbName}.sv`;
                    try {
                      const hasTb = (await invoke("project_exists", { root, relPath: "tb" })) as boolean;
                      if (!hasTb) {
                        const picked = (window.prompt("No tb/ folder found. Where should the testbench go? (relative path)", rel) || "").trim();
                        if (!picked) return;
                        rel = picked.replace(/\\/g, "/");
                      }
                    } catch {
                      // ignore
                    }

                    // Build a deterministic skeleton (ports + instantiation) to ground the model.
                    let dutText = "";
                    const fromTab = openTabs.find((t) => t.relPath.endsWith(`/${dut}.sv`) || t.title === `${dut}.sv`)?.value;
                    if (fromTab) {
                      dutText = fromTab;
                    } else {
                      // Prefer rtl/<dut>.sv, otherwise find any matching file in the project tree.
                      try {
                        dutText = (await invoke("project_read_file", { root, relPath: `rtl/${dut}.sv` })) as string;
                      } catch {
                        const hit = nodes.find((n) => !n.is_dir && (n.name || "").toLowerCase() === `${dut}.sv`.toLowerCase());
                        if (hit?.path) {
                          try {
                            dutText = (await invoke("project_read_file", { root, relPath: hit.path })) as string;
                          } catch {
                            // ignore
                          }
                        }
                      }
                    }

                    const ports = dutText ? parseModulePorts(dutText, dut) : [];
                    const skeleton = ports.length ? genTbFromPorts(dut, ports) : ensureTrailingNewline(
                      `\`timescale 1ns/1ps\n\nmodule ${tbName}();\n  // TODO: declare signals + instantiate DUT (${dut})\n\n  initial begin\n    // TODO: drive inputs and add checks\n    #100;\n    $finish;\n  end\nendmodule\n`
                    );

                    const prompt =
                      `You are generating a thorough SystemVerilog testbench.\n\n` +
                      `Goal: directed edge-case tests + randomized stimulus (seeded/repeatable) + checks/assertions.\n` +
                      `Use plain SystemVerilog only (no external testing DSL; do NOT use .should).\n` +
                      `Use assert/$fatal (fail fast). Add a small reference model/scoreboard if feasible.\n\n` +
                      `DUT module name: ${dut}\n` +
                      `Testbench file path: ${rel}\n\n` +
                      (dutText
                        ? `DUT source (for ports/behavior):\n\n\`\`\`systemverilog\n${dutText}\n\`\`\`\n\n`
                        : `DUT source not available; infer from port names and write a generic TB.\n\n`) +
                      `Starting TB skeleton (you may rewrite completely):\n\n\`\`\`systemverilog\n${skeleton}\n\`\`\`\n\n` +
                      `Return ONLY JSON, no markdown, no explanation.\n` +
                      `Schema: {"ops":[{"op":"write_file","file":"${rel}","content":"...full tb file..."}]}.\n` +
                      `The content MUST end with a trailing newline.\n`;

                    // Call the model without polluting chat history; apply immediately.
                    // Use a separate AI job busy flag so other UI actions don't clobber the state.
                    const jobId = nowId();
                    aiJobIdRef.current = jobId;
                    setAiApplyStatus(`Generating testbench… (${rel})`);
                    setAiApplyDetails("");
                    setAiJobBusy(true);
                    setAiOpen(true);
                    setBottomTab("terminal");
                    try {
                      const messagesForModel: AiMessage[] = [...aiMessages, { role: "user", content: prompt }];
                      const res = (await invoke("ai_chat", {
                        root,
                        provider: aiProvider,
                        messages: messagesForModel,
                        includeProject: aiIncludeProject,
                      })) as AiChatResult;

                      const reply = (res.output || "").trim();
                      if (aiJobIdRef.current !== jobId) return;
                      setAiApplyDetails(reply);

                      const parsed = tryParseJsonAny(reply);
                      let ops = extractAiOps(parsed) || [];
                      if (!ops.length) {
                        throw new Error("AI did not return JSON ops.");
                      }

                      // Force any write_file/create_file ops to land at our chosen rel path.
                      ops = ops.map((o: any) => {
                        if (o && (o.op === "write_file" || o.op === "create_file")) {
                          return { ...o, file: rel };
                        }
                        return o;
                      });

                      const tbOp = ops.find((o: any) => o && (o.op === "write_file" || o.op === "create_file") && (o.file || "") === rel) as any;
                      const tbContent = (tbOp?.content || "").toString().replace(/\r\n/g, "\n").trim();
                      const skeletonNorm = (skeleton || "").replace(/\r\n/g, "\n").trim();

                      const hasChecks = /\bassert\b|\$fatal\b|\$error\b/i.test(tbContent);
                      const hasDrive = /\n\s*[a-zA-Z_][a-zA-Z0-9_]*\s*<=|\n\s*[a-zA-Z_][a-zA-Z0-9_]*\s*=/.test(tbContent);
                      const stillTodo = /TODO/i.test(tbContent);
                      const hasShouldDsl = /\.[Ss]hould\b/.test(tbContent);
                      const unchanged = tbContent && skeletonNorm && tbContent === skeletonNorm;

                      const needsClock = /\blogic\s+clk\b|\binput\b[^\n]*\bclk\b/i.test(dutText) || /\bclk\b/i.test(skeletonNorm);
                      const hasClockGen = /always\s*#\s*\d+\s*clk\s*=\s*~clk|always\s*@\([^\)]*\)\s*clk\s*=\s*~clk/i.test(tbContent);

                      if (unchanged || stillTodo || hasShouldDsl || !hasChecks || !hasDrive || (needsClock && !hasClockGen)) {
                        // One retry with stricter instructions.
                        const retryPrompt =
                          prompt +
                          `\n\nSTRICT REQUIREMENTS (must satisfy):\n` +
                          `- DO NOT use any testing DSL like \'should\' (no .should). Use plain SystemVerilog only.\n` +
                          `- DO NOT return the provided skeleton unchanged.\n` +
                          `- MUST include clock generation if DUT has a clock (e.g. always #5 clk = ~clk;).\n` +
                          `- MUST drive DUT inputs over time (directed + random where applicable).\n` +
                          `- MUST include at least 3 checks using assert or $fatal (scoreboard/ref model if possible).\n` +
                          `- Remove all TODOs.\n`;

                        setAiApplyStatus(`Generating testbench (retry)… (${rel})`);
                        const res2 = (await invoke("ai_chat", {
                          root,
                          provider: aiProvider,
                          messages: [...aiMessages, { role: "user", content: retryPrompt }],
                          includeProject: aiIncludeProject,
                        })) as AiChatResult;

                        const reply2 = (res2.output || "").trim();
                        if (aiJobIdRef.current !== jobId) return;
                        setAiApplyDetails(reply2);
                        const parsed2 = tryParseJsonAny(reply2);
                        let ops2 = extractAiOps(parsed2) || [];
                        if (!ops2.length) throw new Error("AI did not return JSON ops (retry).");
                        ops2 = ops2.map((o: any) => {
                          if (o && (o.op === "write_file" || o.op === "create_file")) return { ...o, file: rel };
                          return o;
                        });
                        ops = ops2;
                      }

                      await applyOpsDirect(ops, { title: "Testbench", defaultOverwrite: true, allowCreateSuffixPrompt: false });
                      await maybeUpdateFilelist(rel);
                      await invoke("project_set_top", { root, top: tbName });
                      await refreshTops(root);
                      if (aiJobIdRef.current !== jobId) return;
                      setAiApplyStatus(`Testbench generated: ${rel}`);
                    } catch (e: any) {
                      const msg = String(e?.message ?? e ?? "");
                      if (aiJobIdRef.current !== jobId) return;
                      setAiApplyStatus(`Testbench error: ${msg}`);
                      pushRun({ title: "Testbench (error)", output: msg });
                    } finally {
                      if (aiJobIdRef.current === jobId) setAiJobBusy(false);
                    }
                  })();
                }}
                disabled={busy || !root}
              >
                Create Testbench…
              </button>
            </div>
          </details>

          <details
            className="menu"
            ref={projectMenuRef}
            onToggle={() => {
              if (!projectMenuRef.current?.open) return;
              if (buildMenuRef.current) buildMenuRef.current.open = false;
              if (filesMenuRef.current) filesMenuRef.current.open = false;
              if (toolsMenuRef.current) toolsMenuRef.current.open = false;
            }}
          >
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
                <div className="menu__label" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>Top module</span>
                  <button
                    className="btn"
                    style={{ padding: "2px 8px" }}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      void refreshTops(root);
                    }}
                    disabled={busy || !root}
                    title="Refresh top candidates"
                  >
                    ↻
                  </button>
                </div>
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

                <button
                  className="menu__item"
                  onClick={() => {
                    closeMenus();
                    void (async () => {
                      if (!root) return;
                      const nextTop = (window.prompt("Set top module (manual)", topValue || "") || "").trim();
                      if (!nextTop) return;
                      const dirtyCount = openTabs.filter((t) => t.dirty).length;
                      if (dirtyCount > 0) {
                        const ok = window.confirm(`You have ${dirtyCount} unsaved file(s).\n\nChange top to ${nextTop}?`);
                        if (!ok) return;
                      }
                      setTopValue(nextTop);
                      setBusy(true);
                      try {
                        await invoke("project_set_top", { root, top: nextTop });
                        try { localStorage.setItem(lsTopKey(root), nextTop); } catch {}
                        pushRun({ title: "Set Top", output: `Top module set to: ${nextTop}` });
                      } catch (e: any) {
                        pushRun({ title: "Set Top (error)", output: String(e ?? "") });
                      } finally {
                        setBusy(false);
                        setPhase("idle");
                      }
                    })();
                  }}
                  disabled={busy || !root}
                >
                  Set top…
                </button>
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

          <details
            className="menu"
            ref={toolsMenuRef}
            onToggle={() => {
              if (!toolsMenuRef.current?.open) return;
              if (buildMenuRef.current) buildMenuRef.current.open = false;
              if (filesMenuRef.current) filesMenuRef.current.open = false;
              if (projectMenuRef.current) projectMenuRef.current.open = false;
            }}
          >
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
pacman -S --needed \\\n  make \\\n  mingw-w64-ucrt-x86_64-gcc \\\n  mingw-w64-ucrt-x86_64-make \\\n  mingw-w64-ucrt-x86_64-verilator \\\n  python \\\n  mingw-w64-ucrt-x86_64-gtkwave`}
            </pre>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                className="btn"
                onClick={() =>
                  void (async () => {
                    try {
                      await navigator.clipboard.writeText(
                        `pacman -Syu\n\npacman -S --needed \\\n  make \\\n  mingw-w64-ucrt-x86_64-gcc \\\n  mingw-w64-ucrt-x86_64-make \\\n  mingw-w64-ucrt-x86_64-verilator \\\n  python \\\n  mingw-w64-ucrt-x86_64-gtkwave`
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
            data-label="AI"
            aria-label="AI"
            onClick={() => {
              setAiOpen((v) => !v);
              if (!aiOpen) setActivityTab("ai");
            }}
          >
            AI
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
                          <div
                            key={n.path}
                            onDragOver={(e) => {
                              // Important: preventDefault here (container), not just the button,
                              // otherwise some browsers show the ⛔ icon when hovering child spans.
                              e.preventDefault();
                              e.dataTransfer.dropEffect = "move";
                              setDragOverPath(n.path);
                            }}
                            onDragLeave={() => {
                              setDragOverPath((prev) => (prev === n.path ? "" : prev));
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              const from = e.dataTransfer.getData("text/plain") || "";
                              void moveTreePath(from, n.path);
                            }}
                          >
                            <div
                              role="button"
                              tabIndex={0}
                              className={
                                "treeRow treeRow--dir " +
                                (selected === n.path ? "is-selected " : "") +
                                (dragOverPath === n.path ? "is-dragOver" : "")
                              }
                              style={{ paddingLeft: pad }}
                              onMouseDown={(e) => {
                                if (e.button !== 0) return;
                                dragStartRef.current = { x: e.clientX, y: e.clientY, path: n.path };
                              }}
                              onMouseEnter={() => {
                                if (dragging && dragFromPath) setDragOverPath(n.path);
                              }}
                              onMouseUp={() => {
                                if (dragging && dragFromPath && dragFromPath !== n.path) {
                                  void moveTreePath(dragFromPath, n.path);
                                }
                              }}
                              onClick={() => {
                                if (dragging) return;
                                setSelected(n.path);
                                toggleExpanded(n.path);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  setSelected(n.path);
                                  toggleExpanded(n.path);
                                }
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
                            </div>
                            {isOpen ? n.children.map((c) => renderNode(c, depth + 1)) : null}
                          </div>
                        );
                      }

                      const lower = n.name.toLowerCase();
                      const icon = lower.endsWith(".sv") || lower.endsWith(".svh") || lower.endsWith(".v") ? "{}" : lower.endsWith(".json") ? "{ }" : lower.endsWith(".f") ? "≡" : "·";
                      return (
                        <div
                          key={n.path}
                          role="button"
                          tabIndex={0}
                          className={"treeRow treeRow--file " + (selected === n.path ? "is-selected" : "")}
                          style={{ paddingLeft: pad + 18 }}
                          onMouseDown={(e) => {
                            if (e.button !== 0) return;
                            dragStartRef.current = { x: e.clientX, y: e.clientY, path: n.path };
                          }}
                          onClick={() => {
                            if (dragging) return;
                            setSelected(n.path);
                            void openFile(n.path);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setSelected(n.path);
                              void openFile(n.path);
                            }
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setSelected(n.path);
                            setCtxMenu({ x: e.clientX, y: e.clientY, path: n.path, isDir: false });
                          }}
                        >
                          <span className="treeIcon treeIcon--file">{icon}</span>
                          <span className="treeName">{n.name}</span>
                        </div>
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
                  // (inline patch preview disabled)
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

              {/* inline patch preview disabled */}
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
          <button className={"bottomTab " + (bottomTab === "shell" ? "is-active" : "")} onClick={() => { setBottomTab("shell"); void startShell(); }}>
            Shell
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

          {bottomTab === "shell" ? (
            <div className="terminal">
              <div className="terminal__head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div className="muted" style={{ fontSize: 12 }}>
                  {termSessionId ? `session: ${termSessionId}` : "(not started)"}
                </div>
                <div className="terminal__actions">
                  <button
                    className="btn"
                    onClick={() => {
                      if (!termRef.current) return;
                      termRef.current.clear();
                    }}
                    disabled={!termRef.current}
                  >
                    Clear
                  </button>
                  <button className="btn" onClick={() => void startShell()} disabled={!root || !!termSessionIdRef.current}>
                    Start
                  </button>
                  <button className="btn" onClick={() => void stopShell()} disabled={!termSessionIdRef.current}>
                    Stop
                  </button>
                </div>
              </div>
              <div className="terminal__body shell__body" ref={termDivRef} />
            </div>
          ) : null}

          {/* AI panel is only the right sidebar now */}
        </div>
      </div>

      {aiReviewOpen ? (
        <div
          className="ctx"
          style={{ left: "50%", top: 70, width: 760, maxWidth: "calc(100vw - 80px)", transform: "translateX(-50%)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px" }}>
            <div style={{ fontWeight: 800 }}>{aiReviewTitle || "Review changes"}</div>
            <button className="btn" onClick={() => setAiReviewOpen(false)} disabled={busy}>
              Close
            </button>
          </div>
          <div className="ctx__sep" />
          <div style={{ padding: 10, display: "grid", gap: 10 }}>
            {aiReviewOps.map((op, idx) => (
              <div key={idx} style={{ border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, padding: 10 }}>
                <label className="check" style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={aiReviewChecks[idx] ?? true}
                    onChange={(e) => setAiReviewChecks((prev) => ({ ...prev, [idx]: e.target.checked }))}
                    disabled={busy}
                  />
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <div style={{ fontWeight: 700, fontSize: 12 }}>{(op as any).op} · {(op as any).file}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{aiReviewPreview[idx] ? "Preview ready" : "(building preview…)"}</div>
                  </div>
                </label>
                {aiReviewPreview[idx] ? (
                  <pre className="terminal__body" style={{ marginTop: 8, maxHeight: 180, overflow: "auto" }}>{aiReviewPreview[idx]}</pre>
                ) : null}
              </div>
            ))}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="btn" onClick={() => setAiReviewOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => void applyAiOps()} disabled={busy}>
                Apply selected
              </button>
            </div>
          </div>
        </div>
      ) : null}

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

          <details className="aiDock__settings">
            <summary className="aiDock__settingsSummary">Settings</summary>
            <div className="aiDock__settingsPanel">
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

              {aiApplyStatus ? (
                <div style={{ marginTop: 10 }}>
                  <div className="menu__label">Last apply</div>
                  <div className="muted" style={{ fontSize: 12 }}>{aiApplyStatus}</div>
                  <div className="menu__label" style={{ marginTop: 8 }}>Details</div>
                  <pre className="terminal__body" style={{ marginTop: 6, maxHeight: 160, overflow: "auto" }}>{aiApplyDetails || "(no details)"}</pre>
                </div>
              ) : null}
            </div>
          </details>

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

                    {m.role === "assistant" && tryExtractCodeBlock(m.content) && !looksLikeDiff(tryExtractCodeBlock(m.content) || "") ? (
                      <div style={{ display: "flex", gap: 8, marginTop: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                        <button className="btn" onClick={() => void createFileFromAssistant(idx)} disabled={busy || aiJobBusy || !root}>
                          Create file…
                        </button>
                      </div>
                    ) : null}

                    {patch ? (
                      <div style={{ display: "flex", gap: 8, marginTop: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                        <button className="btn primary" onClick={() => void applyAssistantAuto(idx)} disabled={busy || aiJobBusy || !root}>
                          Review + Apply…
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}

            {aiJobBusy ? (
              <div className="aiMsg aiMsg--assistant aiMsg--thinking">
                <div className="aiMsg__role">assistant</div>
                <div className="aiMsg__content">
                  Thinking<span className="dots" />
                </div>
              </div>
            ) : null}
          </div>

          <div className="aiDock__input">
            <textarea
              className="aiInput"
              value={aiInput}
              onChange={(e) => setAiInput(e.target.value)}
              placeholder={root ? "Ask svAi…" : "Open a project first…"}
              disabled={aiJobBusy || !root}
              rows={3}
              onContextMenu={(e) => {
                // Provide a reliable context menu (WebView2 sometimes doesn't show native menus).
                e.preventDefault();
                textCtxTargetRef.current = e.currentTarget;
                setTextCtxMenu({ x: e.clientX, y: e.clientY, kind: "textarea" });
              }}
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
              <button className="btn primary" onClick={() => void aiSend(aiInput)} disabled={aiJobBusy || !root || !aiInput.trim()}>
                Send
              </button>
            </div>
          </div>
      </div>

      {/* patch preview modal disabled */}

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

      {confirmDeletePath ? (
        <div
          className="ctx"
          style={{ left: "50%", top: 90, width: 420, maxWidth: "calc(100vw - 80px)", transform: "translateX(-50%)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px" }}>
            <div style={{ fontWeight: 800 }}>Confirm delete</div>
            <button className="btn" onClick={() => setConfirmDeletePath("") } disabled={busy}>
              Close
            </button>
          </div>
          <div className="ctx__sep" />
          <div style={{ padding: 10, display: "grid", gap: 10 }}>
            <div className="muted">Delete: <span className="mono">{confirmDeletePath}</span></div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="btn" onClick={() => setConfirmDeletePath("")} disabled={busy}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  const target = confirmDeletePath;
                  setConfirmDeletePath("");
                  void deletePath(target);
                }}
                disabled={busy}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {textCtxMenu ? (
        <div className="ctx" style={{ left: textCtxMenu.x, top: textCtxMenu.y }}>
          <button
            className="ctx__item"
            onClick={() => {
              void textCtxDo("cut");
              closeTextCtxMenu();
            }}
          >
            Cut
          </button>
          <button
            className="ctx__item"
            onClick={() => {
              void textCtxDo("copy");
              closeTextCtxMenu();
            }}
          >
            Copy
          </button>
          <button
            className="ctx__item"
            onClick={() => {
              void textCtxDo("paste");
              closeTextCtxMenu();
            }}
          >
            Paste
          </button>
          <div className="ctx__sep" />
          <button
            className="ctx__item"
            onClick={() => {
              void textCtxDo("selectAll");
              closeTextCtxMenu();
            }}
          >
            Select all
          </button>
        </div>
      ) : null}

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

          <button
            className="ctx__item"
            onClick={() => {
              const p = ctxMenu.path;
              setCtxMenu(null);
              void saveTabByRel(p);
            }}
            disabled={ctxMenu.isDir}
          >
            Save
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
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setConfirmDeletePath(ctxMenu.path);
              setCtxMenu(null);
            }}
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}
