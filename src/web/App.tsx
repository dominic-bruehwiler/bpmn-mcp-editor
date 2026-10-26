/**
 * Editor shell: process list, Camunda modeler, and the agent-lock banner.
 * Diagram updates arrive over a WebSocket, with a short poll as a fallback for the stdio MCP process.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import {
  AlignHorizontalSpaceAround,
  Download,
  ListChecks,
  Lock,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Sun,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { api, ApiError, type LintIssue, type ProcessDetails, type ProcessSummary } from "@/lib/api";
import { BpmnCanvas, type CanvasHandle } from "@/components/bpmn-canvas";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const PROCESS_PANEL_STORAGE_KEY = "bpmn-editor.process-panel-open";

function readProcessPanelOpen(): boolean {
  try {
    const stored = localStorage.getItem(PROCESS_PANEL_STORAGE_KEY);
    if (stored === "0") return false;
    if (stored === "1") return true;
  } catch {
    /* ignore */
  }
  return true;
}

export function App() {
  const [processes, setProcesses] = useState<ProcessSummary[]>([]);
  const [current, setCurrent] = useState<ProcessDetails | null>(null);
  const [issues, setIssues] = useState<LintIssue[]>([]);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProcessSummary | null>(null);
  const [draftName, setDraftName] = useState("");
  const [processPanelOpen, setProcessPanelOpen] = useState(readProcessPanelOpen);
  const [status, setStatus] = useState("Ready");
  const canvasRef = useRef<CanvasHandle>(null);
  const currentRef = useRef<ProcessDetails | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const fileRef = useRef<HTMLInputElement>(null);
  const { resolvedTheme, setTheme } = useTheme();

  currentRef.current = current;
  const locked = current?.lock?.holder === "agent";

  const openProcess = useCallback(async (id: string) => {
    const details = await api.get(id);
    setCurrent(details);
    setIssues([]);
  }, []);

  useEffect(() => {
    api.list().then((rows) => {
      setProcesses(rows);
      if (rows[0]) void openProcess(rows[0].id);
    }).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : "Could not load processes.");
    });
  }, [openProcess]);

  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    // Vite's HTTP proxy does not complete Bun's WebSocket upgrade, so the dev
    // client talks to the API port directly. Production is same-origin.
    const url = import.meta.env.DEV
      ? `${protocol}//127.0.0.1:3001/ws`
      : `${protocol}//${location.host}/ws`;
    let socket: WebSocket | undefined;
    let closed = false;

    const connect = () => {
      socket = new WebSocket(url);
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as
          | { type: "process.updated"; process: ProcessDetails }
          | { type: "process.deleted"; id: string };
        if (message.type === "process.deleted") {
          setProcesses((rows) => rows.filter((row) => row.id !== message.id));
          setCurrent((row) => (row?.id === message.id ? null : row));
          return;
        }
        const process = message.process;
        setProcesses((rows) => {
          const next = rows.filter((row) => row.id !== process.id);
          return [{ ...process }, ...next].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        });
        setCurrent((row) => {
          if (row?.id !== process.id) return row;
          if (row.revision === process.revision) {
            return { ...row, lock: process.lock, userActive: process.userActive, name: process.name };
          }
          window.clearTimeout(saveTimer.current);
          return process;
        });
      };
      socket.onclose = () => {
        if (!closed) window.setTimeout(connect, 1500);
      };
    };

    connect();
    return () => {
      closed = true;
      socket?.close();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void api.list().then((rows) => {
        setProcesses(rows);
        const open = currentRef.current;
        const match = open ? rows.find((row) => row.id === open.id) : undefined;
        if (!open || !match || match.revision === open.revision) {
          if (open && match) {
            setCurrent((row) => row ? { ...row, lock: match.lock, userActive: match.userActive, name: match.name } : row);
          }
          return;
        }
        void api.get(open.id).then((details) => {
          window.clearTimeout(saveTimer.current);
          setCurrent(details);
        });
      }).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, []);

  const persist = useCallback(async (xml: string) => {
    const open = currentRef.current;
    if (!open || open.lock?.holder === "agent") return;
    setStatus("Saving");
    try {
      const saved = await api.save(open.id, xml, open.revision);
      canvasRef.current?.acknowledge(saved.revision);
      setCurrent(saved);
      setProcesses((rows) => rows.map((row) => row.id === saved.id ? { ...row, ...saved } : row));
      setStatus("Saved");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Save failed.";
      toast.error(message);
      setStatus("Not saved");
      if (error instanceof ApiError && error.status === 409) {
        const fresh = await api.get(open.id);
        setCurrent(fresh);
      }
    }
  }, []);

  const onEdit = useCallback(() => {
    const open = currentRef.current;
    if (!open || open.lock) return;
    setStatus("Editing");
    void api.presence(open.id).catch(() => undefined);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void canvasRef.current?.getXml().then((xml) => persist(xml));
    }, 500);
  }, [persist]);

  async function createProcess() {
    const name = draftName.trim();
    if (!name) return;
    try {
      const created = await api.create(name);
      setProcesses((rows) => [created, ...rows]);
      setCurrent(created);
      setIssues([]);
      setDraftName("");
      setCreateOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the process.");
    }
  }

  async function rename(name: string) {
    if (!current || name.trim() === current.name || !name.trim()) return;
    try {
      const saved = await api.rename(current.id, name.trim(), current.revision);
      setCurrent(saved);
      setProcesses((rows) => rows.map((row) => row.id === saved.id ? { ...row, name: saved.name, revision: saved.revision } : row));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not rename.");
    }
  }

  async function removeProcess() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    try {
      await api.remove(id);
      const remaining = processes.filter((row) => row.id !== id);
      setProcesses(remaining);
      setDeleteTarget(null);
      if (current?.id === id) {
        setCurrent(null);
        if (remaining[0]) await openProcess(remaining[0].id);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete.");
    }
  }

  async function align() {
    if (!current || locked) return;
    try {
      const saved = await api.layout(current.id, current.revision);
      setCurrent(saved);
      setStatus("Aligned");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not align.");
    }
  }

  async function validate() {
    if (!current) return;
    try {
      const report = await api.validate(current.id);
      setIssues(report.issues);
      setIssuesOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Validation failed.");
    }
  }

  async function download() {
    const xml = await canvasRef.current?.getXml();
    if (!xml || !current) return;
    const url = URL.createObjectURL(new Blob([xml], { type: "application/xml" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${current.name}.bpmn`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importFile(file: File) {
    if (!current || locked) return;
    const xml = await file.text();
    await persist(xml);
  }

  const errorCount = issues.filter((issue) => issue.severity === "error").length;

  const toggleProcessPanel = useCallback(() => {
    setProcessPanelOpen((open) => {
      const next = !open;
      try {
        localStorage.setItem(PROCESS_PANEL_STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-sm font-semibold tracking-tight">BPMN MCP Modeler</span>
        {current ? (
          <Input
            key={current.id + current.name}
            defaultValue={current.name}
            aria-label="Process name"
            className="h-8 max-w-64"
            disabled={locked}
            onBlur={(event) => void rename(event.target.value)}
          />
        ) : null}
        {current ? <Badge variant="outline">r{current.revision}</Badge> : null}
        {locked ? (
          <Badge variant="secondary">
            <Lock data-icon="inline-start" />
            Agent
          </Badge>
        ) : null}
        <span className="text-xs text-muted-foreground">{status}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="sm" disabled={!current || locked} onClick={() => void align()}>
            <AlignHorizontalSpaceAround data-icon="inline-start" />
            Align
          </Button>
          <Button variant="outline" size="sm" disabled={!current} onClick={() => void validate()}>
            <ListChecks data-icon="inline-start" />
            Validate
            {errorCount > 0 ? <Badge variant="destructive">{errorCount}</Badge> : null}
          </Button>
          <Button variant="outline" size="sm" disabled={!current} onClick={() => void download()}>
            <Download data-icon="inline-start" />
            Export
          </Button>
          <Button variant="outline" size="sm" disabled={!current || locked} onClick={() => fileRef.current?.click()}>
            Import
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".bpmn,.xml"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importFile(file);
              event.target.value = "";
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label={resolvedTheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          >
            {resolvedTheme === "dark" ? <Sun /> : <Moon />}
          </Button>
        </div>
      </header>

      {locked ? (
        <Alert className="rounded-none border-x-0 border-t-0">
          <Lock />
          <AlertTitle>The agent is editing this diagram</AlertTitle>
          <AlertDescription>
            The canvas is read-only until the lock expires
            {current?.lock?.expiresAt ? ` at ${new Date(current.lock.expiresAt).toLocaleTimeString()}` : ""}.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside
          className={`flex shrink-0 flex-col overflow-hidden border-r transition-[width] duration-200 ease-out ${processPanelOpen ? "w-60" : "w-10"}`}
        >
          {processPanelOpen ? (
            <>
              <div className="flex items-center justify-between gap-1 px-2 py-2">
                <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">Processes</span>
                <div className="flex shrink-0 items-center">
                  <Button variant="ghost" size="icon-sm" aria-label="New process" onClick={() => setCreateOpen(true)}>
                    <Plus />
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Hide process list"
                        onClick={toggleProcessPanel}
                      >
                        <PanelLeftClose />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="right">Hide process list</TooltipContent>
                  </Tooltip>
                </div>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="flex flex-col gap-0.5 px-2 pb-2">
                  {processes.map((process) => (
                    <div
                      key={process.id}
                      className={`group flex items-center rounded-md ${process.id === current?.id ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
                        onClick={() => void openProcess(process.id)}
                      >
                        <span className="min-w-0 flex-1 truncate">{process.name}</span>
                        {process.lock ? <Lock className="size-3 shrink-0 text-muted-foreground" /> : null}
                      </button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Delete ${process.name}`}
                        className="mr-1 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:text-destructive focus-visible:opacity-100"
                        disabled={process.lock?.holder === "agent"}
                        onClick={() => setDeleteTarget(process)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))}
                  {processes.length === 0 ? (
                    <p className="px-2 py-4 text-sm text-muted-foreground">No processes yet.</p>
                  ) : null}
                </div>
              </ScrollArea>
            </>
          ) : (
            <div className="flex flex-col items-center gap-1 py-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Show process list"
                    onClick={toggleProcessPanel}
                  >
                    <PanelLeftOpen />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Show process list</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="New process" onClick={() => setCreateOpen(true)}>
                    <Plus />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">New process</TooltipContent>
              </Tooltip>
            </div>
          )}
        </aside>

        <main className={`flex min-w-0 flex-1 ${locked ? "pointer-events-none opacity-80" : ""}`}>
          {current ? (
            <BpmnCanvas
              ref={canvasRef}
              processId={current.id}
              xml={current.xml}
              revision={current.revision}
              locked={locked}
              issues={issues}
              onEdit={onEdit}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Create a process to start modeling.
            </div>
          )}
        </main>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New process</DialogTitle>
            <DialogDescription>Creates an executable Camunda 7 process with a start event.</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void createProcess();
            }}
          >
            <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor="process-name">
              Name
              <Input id="process-name" value={draftName} onChange={(event) => setDraftName(event.target.value)} autoFocus />
            </label>
            <DialogFooter>
              <Button type="submit">Create</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.name}?</DialogTitle>
            <DialogDescription>The stored BPMN diagram is removed.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void removeProcess()}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={issuesOpen} onOpenChange={setIssuesOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Camunda 7 validation</DialogTitle>
            <DialogDescription>
              {issues.length === 0 ? "No findings." : `${errorCount} errors, ${issues.length - errorCount} other findings.`}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-80">
            <div className="flex flex-col gap-2 pr-3">
              {issues.map((issue, index) => (
                <button
                  key={`${issue.rule}-${issue.elementId ?? "diagram"}-${index}`}
                  type="button"
                  className="flex flex-col gap-1 rounded-md border px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => issue.elementId && canvasRef.current?.focusElement(issue.elementId)}
                >
                  <span className="flex items-center gap-2">
                    <Badge variant={issue.severity === "error" ? "destructive" : "outline"}>{issue.severity}</Badge>
                    <span className="text-xs text-muted-foreground">{issue.elementId ?? issue.rule}</span>
                  </span>
                  <span>{issue.message}</span>
                </button>
              ))}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}
