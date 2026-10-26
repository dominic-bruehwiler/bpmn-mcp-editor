/**
 * Auto-layout. bpmn-auto-layout redraws a single process and keeps Camunda attributes.
 * Collaborations with several pools are left in place; only elements that have no DI are appended.
 */
import { layoutProcess } from "bpmn-auto-layout";
import { children, hasMultipleParticipants, readDiagram, writeDiagram, type Element } from "./moddle";

const SIZES: Record<string, { width: number; height: number }> = {
  "bpmn:StartEvent": { width: 36, height: 36 },
  "bpmn:EndEvent": { width: 36, height: 36 },
  "bpmn:IntermediateCatchEvent": { width: 36, height: 36 },
  "bpmn:IntermediateThrowEvent": { width: 36, height: 36 },
  "bpmn:BoundaryEvent": { width: 36, height: 36 },
  "bpmn:ExclusiveGateway": { width: 50, height: 50 },
  "bpmn:ParallelGateway": { width: 50, height: 50 },
  "bpmn:InclusiveGateway": { width: 50, height: 50 },
  "bpmn:EventBasedGateway": { width: 50, height: 50 },
  "bpmn:TextAnnotation": { width: 160, height: 30 },
};

export async function layoutDiagram(xml: string): Promise<string> {
  const diagram = await readDiagram(xml);
  let next = xml;
  if (!hasMultipleParticipants(diagram.definitions)) {
    try {
      next = await layoutProcess(xml);
    } catch (error) {
      console.error("bpmn-auto-layout failed, placing only missing shapes.", error);
    }
  }
  return placeMissing(next);
}

async function placeMissing(xml: string): Promise<string> {
  const diagram = await readDiagram(xml);
  const plane = ensurePlane(diagram);
  const planeElements = children(plane, "planeElement");
  const shaped = new Set(
    planeElements
      .map((shape) => (shape.bpmnElement as Element | undefined)?.id)
      .filter((id): id is string => Boolean(id)),
  );

  let cursor = maxRight(planeElements) + 80;
  const elements = children(diagram.process, "flowElements");
  for (const element of elements) {
    if (!element.id || shaped.has(element.id) || element.$type === "bpmn:SequenceFlow" || element.$type === "bpmn:Association") {
      continue;
    }
    const size = SIZES[element.$type] ?? { width: 100, height: 80 };
    planeElements.push(
      diagram.moddle.create("bpmndi:BPMNShape", {
        id: `${element.id}_di`,
        bpmnElement: element,
        bounds: diagram.moddle.create("dc:Bounds", { x: cursor, y: 180, ...size }),
      }),
    );
    shaped.add(element.id);
    cursor += size.width + 60;
  }

  for (const element of elements) {
    if (!element.id || shaped.has(element.id)) continue;
    if (element.$type !== "bpmn:SequenceFlow" && element.$type !== "bpmn:Association") continue;
    const source = element.sourceRef as Element | undefined;
    const target = element.targetRef as Element | undefined;
    const sourceBounds = boundsOf(planeElements, source?.id);
    const targetBounds = boundsOf(planeElements, target?.id);
    if (!sourceBounds || !targetBounds) continue;
    planeElements.push(
      diagram.moddle.create("bpmndi:BPMNEdge", {
        id: `${element.id}_di`,
        bpmnElement: element,
        waypoint: [
          diagram.moddle.create("dc:Point", {
            x: sourceBounds.x + sourceBounds.width,
            y: sourceBounds.y + sourceBounds.height / 2,
          }),
          diagram.moddle.create("dc:Point", {
            x: targetBounds.x,
            y: targetBounds.y + targetBounds.height / 2,
          }),
        ],
      }),
    );
    shaped.add(element.id);
  }

  plane.planeElement = planeElements;
  return writeDiagram(diagram);
}

function ensurePlane(diagram: { moddle: { create: (type: string, attributes?: Record<string, unknown>) => Element }; definitions: Element; process: Element }): Element {
  const diagrams = children(diagram.definitions, "diagrams");
  const existing = diagrams[0];
  const plane = existing ? children(existing, "plane")[0] ?? (existing.plane as Element | undefined) : undefined;
  if (existing && plane) {
    if (!Array.isArray(plane.planeElement)) plane.planeElement = [];
    return plane;
  }

  const createdPlane = diagram.moddle.create("bpmndi:BPMNPlane", {
    id: "BPMNPlane_1",
    bpmnElement: diagram.process,
    planeElement: [],
  });
  const createdDiagram = diagram.moddle.create("bpmndi:BPMNDiagram", {
    id: "BPMNDiagram_1",
    plane: createdPlane,
  });
  diagram.definitions.diagrams = [createdDiagram];
  return createdPlane;
}

function maxRight(planeElements: Element[]): number {
  let max = 120;
  for (const shape of planeElements) {
    const bounds = shape.bounds as { x?: number; width?: number } | undefined;
    if (bounds?.x !== undefined && bounds.width !== undefined) {
      max = Math.max(max, bounds.x + bounds.width);
    }
  }
  return max;
}

function boundsOf(planeElements: Element[], id: string | undefined): { x: number; y: number; width: number; height: number } | undefined {
  if (!id) return undefined;
  const shape = planeElements.find((entry) => (entry.bpmnElement as Element | undefined)?.id === id);
  const bounds = shape?.bounds as { x: number; y: number; width: number; height: number } | undefined;
  if (!bounds || bounds.x === undefined) return undefined;
  return bounds;
}
