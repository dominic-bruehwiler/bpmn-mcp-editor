/**
 * bpmn-js modeler with the Camunda 7 properties panel.
 * Remote revisions are imported; local edits are reported upward and are not written back into the canvas.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import BpmnModeler from "bpmn-js/lib/Modeler";
import {
  BpmnPropertiesPanelModule,
  BpmnPropertiesProviderModule,
  CamundaPlatformPropertiesProviderModule,
} from "bpmn-js-properties-panel";
import camundaModdle from "camunda-bpmn-moddle/resources/camunda.json";
import camundaPlatformBehaviors from "camunda-bpmn-js-behaviors/lib/camunda-platform";
import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-js.css";
import "bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css";
import "@bpmn-io/properties-panel/dist/assets/properties-panel.css";
import type { LintIssue } from "@/lib/api";

const PROPERTIES_PANEL_STORAGE_KEY = "bpmn-editor.properties-panel-open";

function readPropertiesPanelOpen(): boolean {
  try {
    const stored = localStorage.getItem(PROPERTIES_PANEL_STORAGE_KEY);
    if (stored === "0") return false;
    if (stored === "1") return true;
  } catch {
    /* ignore */
  }
  return true;
}

export type CanvasHandle = {
  acknowledge: (revision: number) => void;
  getXml: () => Promise<string>;
  focusElement: (elementId: string) => void;
};

type BpmnCanvasProps = {
  processId: string;
  xml: string;
  revision: number;
  locked: boolean;
  issues: LintIssue[];
  onEdit: () => void;
};

/** Centers the diagram after import once the canvas container has real dimensions. */
function fitCanvasToDiagram(modeler: BpmnModeler) {
  const canvas = modeler.get("canvas");

  const apply = () => {
    canvas.resized?.();
    const viewbox = canvas.viewbox?.() as
      | { inner: { x: number; y: number; width: number; height: number }; outer: { width: number; height: number } }
      | undefined;
    if (!viewbox?.outer.width || !viewbox.outer.height) return false;
    const { inner } = viewbox;
    // Passing a center skips diagram-js's "fits without zoom → pin to origin" branch.
    canvas.zoom?.("fit-viewport", {
      x: inner.x + inner.width / 2,
      y: inner.y + inner.height / 2,
    });
    return true;
  };

  const retry = (attemptsLeft: number) => {
    requestAnimationFrame(() => {
      if (apply() || attemptsLeft <= 0) return;
      retry(attemptsLeft - 1);
    });
  };
  retry(4);
}

export const BpmnCanvas = forwardRef<CanvasHandle, BpmnCanvasProps>(function BpmnCanvas(
  { processId, xml, revision, locked, issues, onEdit },
  ref,
) {
  const canvasNode = useRef<HTMLDivElement>(null);
  const propertiesNode = useRef<HTMLDivElement>(null);
  const modelerRef = useRef<BpmnModeler | null>(null);
  const shown = useRef("");
  const suppress = useRef(0);
  const lockedRef = useRef(locked);
  const onEditRef = useRef(onEdit);
  const processIdRef = useRef(processId);
  const issuesRef = useRef(issues);
  const marked = useRef<string[]>([]);
  const generation = useRef(0);
  const [propertiesPanelOpen, setPropertiesPanelOpen] = useState(readPropertiesPanelOpen);

  lockedRef.current = locked;
  onEditRef.current = onEdit;
  processIdRef.current = processId;
  issuesRef.current = issues;

  const paintMarkers = () => {
    const modeler = modelerRef.current;
    if (!modeler) return;
    const canvas = modeler.get("canvas");
    const registry = modeler.get("elementRegistry");
    for (const id of marked.current) {
      canvas.removeMarker?.(id, "lint-error");
      canvas.removeMarker?.(id, "lint-warning");
    }
    marked.current = [];
    for (const issue of issuesRef.current) {
      if (!issue.elementId || !registry.get?.(issue.elementId)) continue;
      const marker = issue.severity === "error" ? "lint-error" : "lint-warning";
      canvas.addMarker?.(issue.elementId, marker);
      marked.current.push(issue.elementId);
    }
  };

  useImperativeHandle(ref, () => ({
    acknowledge(nextRevision: number) {
      shown.current = `${processIdRef.current}:${nextRevision}`;
    },
    async getXml() {
      const saved = await modelerRef.current?.saveXML({ format: true });
      return saved?.xml ?? "";
    },
    focusElement(elementId: string) {
      const modeler = modelerRef.current;
      if (!modeler) return;
      const registry = modeler.get("elementRegistry");
      const selection = modeler.get("selection");
      const canvas = modeler.get("canvas");
      const element = registry.get?.(elementId);
      if (!element) return;
      selection.select?.(element);
      canvas.scrollToElement?.(element);
    },
  }));

  useEffect(() => {
    const canvas = canvasNode.current;
    const properties = propertiesNode.current;
    if (!canvas || !properties) return;

    const modeler = new BpmnModeler({
      container: canvas,
      propertiesPanel: { parent: properties },
      additionalModules: [
        BpmnPropertiesPanelModule,
        BpmnPropertiesProviderModule,
        CamundaPlatformPropertiesProviderModule,
        camundaPlatformBehaviors,
      ],
      moddleExtensions: { camunda: camundaModdle },
    });
    modelerRef.current = modeler;

    const onChanged = () => {
      if (suppress.current > 0 || lockedRef.current) return;
      onEditRef.current();
    };
    modeler.on("commandStack.changed", onChanged);

    return () => {
      modelerRef.current = null;
      modeler.destroy();
    };
  }, [processId]);

  useEffect(() => {
    const modeler = modelerRef.current;
    const key = `${processId}:${revision}`;
    if (!modeler || shown.current === key) return;

    let cancelled = false;
    const token = ++generation.current;
    suppress.current += 1;
    modeler.importXML(xml).then(() => {
      if (!cancelled) {
        shown.current = key;
        fitCanvasToDiagram(modeler);
        paintMarkers();
      }
    }).catch((error: unknown) => {
      if (!cancelled) console.error("Could not import BPMN.", error);
    }).finally(() => {
      if (generation.current === token) suppress.current -= 1;
    });

    return () => {
      cancelled = true;
    };
  }, [processId, revision, xml]);

  useEffect(() => {
    const keyboard = modelerRef.current?.get("keyboard");
    if (!keyboard) return;
    if (locked) keyboard.unbind?.();
    else keyboard.bind?.();
  }, [locked, processId, revision]);

  useEffect(() => {
    paintMarkers();
  }, [issues, revision, processId]);

  useEffect(() => {
    const modeler = modelerRef.current;
    if (!modeler) return;
    const frame = requestAnimationFrame(() => {
      modeler.get("canvas").resized?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [propertiesPanelOpen]);

  const togglePropertiesPanel = useCallback(() => {
    setPropertiesPanelOpen((open) => {
      const next = !open;
      try {
        localStorage.setItem(PROPERTIES_PANEL_STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  return (
    <div className="bio-theme-parent flex min-h-0 min-w-0 flex-1">
      <div ref={canvasNode} className="bpmn-canvas min-w-0 flex-1" />
      <div
        className={`flex min-h-0 shrink-0 flex-col overflow-hidden border-l bg-card transition-[width] duration-200 ease-out ${propertiesPanelOpen ? "w-80" : "w-10"}`}
      >
        {propertiesPanelOpen ? (
          <div className="flex shrink-0 items-center justify-between gap-1 border-b px-2 py-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Hide properties"
                  onClick={togglePropertiesPanel}
                >
                  <PanelRightClose />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">Hide properties</TooltipContent>
            </Tooltip>
            <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">Properties</span>
          </div>
        ) : (
          <div className="flex flex-col items-center py-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Show properties"
                  onClick={togglePropertiesPanel}
                >
                  <PanelRightOpen />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">Show properties</TooltipContent>
            </Tooltip>
          </div>
        )}
        <div
          ref={propertiesNode}
          className={`bpmn-properties min-h-0 flex-1 overflow-auto ${propertiesPanelOpen ? "" : "hidden"}`}
        />
      </div>
    </div>
  );
});
