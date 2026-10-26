/**
 * bpmn-moddle with the Camunda 7 extension loaded.
 * Attribute updates round-trip the existing DI; structural edits are re-laid afterwards.
 */
import { BpmnModdle } from "bpmn-moddle";
import camundaDescriptor from "camunda-bpmn-moddle/resources/camunda.json" with { type: "json" };
import { BadRequestError } from "../errors";

export type Element = {
  $type: string;
  id?: string;
  name?: string;
  [key: string]: unknown;
};

export type Moddle = {
  create: (type: string, attributes?: Record<string, unknown>) => Element;
  fromXML: (xml: string) => Promise<{ rootElement: Element }>;
  toXML: (element: Element, options?: { format?: boolean }) => Promise<{ xml: string }>;
};

export type Diagram = {
  moddle: Moddle;
  definitions: Element;
  process: Element;
};

export function openModdle(): Moddle {
  return BpmnModdle({ camunda: camundaDescriptor }) as Moddle;
}

export async function readDiagram(xml: string): Promise<Diagram> {
  const moddle = openModdle();
  try {
    const { rootElement } = await moddle.fromXML(xml);
    const process = executableProcess(rootElement);
    return { moddle, definitions: rootElement, process };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid BPMN XML.";
    throw new BadRequestError(message);
  }
}

export async function writeDiagram(diagram: Diagram): Promise<string> {
  const { xml } = await diagram.moddle.toXML(diagram.definitions, { format: true });
  return xml;
}

/** Prefer the executable process. Pools stay in the XML; edits target this process. */
export function executableProcess(definitions: Element): Element {
  const roots = children(definitions, "rootElements");
  const processes = roots.filter((element) => element.$type === "bpmn:Process");
  const executable = processes.find((element) => element.isExecutable === true);
  const process = executable ?? processes[0];
  if (!process) {
    throw new BadRequestError("The diagram has no BPMN process.");
  }
  return process;
}

export function hasMultipleParticipants(definitions: Element): boolean {
  const collaboration = children(definitions, "rootElements").find(
    (element) => element.$type === "bpmn:Collaboration",
  );
  return children(collaboration, "participants").length > 1;
}

export function children(element: Element | undefined, property: string): Element[] {
  if (!element) return [];
  const value = element[property];
  return Array.isArray(value) ? (value as Element[]) : [];
}

export function createId(prefix: string, taken: Set<string>): string {
  let id = "";
  do {
    id = `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 7)}`;
  } while (taken.has(id));
  taken.add(id);
  return id;
}

export function collectIds(root: Element): Set<string> {
  const taken = new Set<string>();
  const seen = new Set<object>();

  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const element = value as Element;
    if (typeof element.id === "string") taken.add(element.id);
    for (const nested of Object.values(element)) {
      if (Array.isArray(nested)) nested.forEach(visit);
      else if (nested && typeof nested === "object" && "$type" in nested) visit(nested);
    }
  };

  visit(root);
  return taken;
}

export function flowElementsDeep(container: Element): Element[] {
  const found: Element[] = [];
  const walk = (current: Element) => {
    for (const child of children(current, "flowElements")) {
      found.push(child);
      if (children(child, "flowElements").length > 0 || child.$type === "bpmn:SubProcess") {
        walk(child);
      }
    }
  };
  walk(container);
  return found;
}

export function findElement(diagram: Diagram, id: string): Element | undefined {
  if (diagram.process.id === id) return diagram.process;
  if (diagram.definitions.id === id) return diagram.definitions;
  return flowElementsDeep(diagram.process).find((element) => element.id === id);
}

export function findContainer(process: Element, id: string): Element | undefined {
  const walk = (container: Element): Element | undefined => {
    for (const child of children(container, "flowElements")) {
      if (child.id === id) return container;
      const nested = walk(child);
      if (nested) return nested;
    }
    return undefined;
  };
  return walk(process);
}
