declare module "bpmn-js/lib/Modeler" {
  export default class BpmnModeler {
    constructor(options: Record<string, unknown>);
    importXML(xml: string): Promise<unknown>;
    saveXML(options?: { format?: boolean }): Promise<{ xml?: string }>;
    on(event: string, callback: () => void): void;
    get(name: string): {
      bind?: () => void;
      unbind?: () => void;
      get?: (id: string) => unknown;
      select?: (element: unknown) => void;
      scrollToElement?: (element: unknown) => void;
      addMarker?: (id: string, marker: string) => void;
      removeMarker?: (id: string, marker: string) => void;
      resized?: () => void;
      viewbox?: () => { inner: { x: number; y: number; width: number; height: number }; outer: { width: number; height: number } };
      zoom?: (type: string | number, center?: { x: number; y: number }) => number;
    };
    destroy(): void;
  }
}

declare module "bpmn-js-properties-panel" {
  export const BpmnPropertiesPanelModule: unknown;
  export const BpmnPropertiesProviderModule: unknown;
  export const CamundaPlatformPropertiesProviderModule: unknown;
}

declare module "camunda-bpmn-moddle/resources/camunda.json" {
  const descriptor: object;
  export default descriptor;
}

declare module "camunda-bpmn-js-behaviors/lib/camunda-platform" {
  const behaviors: unknown;
  export default behaviors;
}

declare module "*.css";
