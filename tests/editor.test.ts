import { beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/server/app";
import { editDiagram } from "../src/server/bpmn/edit";
import { lintDiagram } from "../src/server/bpmn/lint";
import { prisma } from "../src/server/db";
import {
  acquireLock,
  createProcess,
  mutateProcess,
  saveUserXml,
} from "../src/server/processes";
import { invoiceDiagram } from "../src/server/sample";
import { ValidationError } from "../src/server/errors";

beforeEach(async () => {
  await prisma.process.deleteMany();
});

describe("bpmn editing", () => {
  test("builds a deployable Camunda 7 invoice process", async () => {
    const xml = await invoiceDiagram();
    expect(xml).toContain('camunda:assignee="demo"');
    expect(xml).toContain("BPMNShape");
    expect(xml).toContain('camunda:historyTimeToLive="180"');
    expect(xml).toContain("${approved}");

    const issues = await lintDiagram(xml, "deploy");
    const errors = issues.filter((issue) => issue.severity === "error");
    expect(errors).toEqual([]);
  });

  test("rejects a service task without an implementation and keeps the diagram unchanged", async () => {
    const created = await createProcess({ name: "Draft", lockForAgent: true });
    const before = created.xml;
    await expect(
      mutateProcess({
        id: created.id,
        lockToken: created.lockToken ?? "",
        expectedRevision: created.revision,
        ops: [{ op: "add", type: "serviceTask", name: "Charge card" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const stored = await prisma.process.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.xml).toBe(before);
    expect(stored.revision).toBe(1);
  });

  test("stores a service task class, a timer, and keeps layout on a property edit", async () => {
    const created = await createProcess({ name: "Fulfillment", lockForAgent: true });
    const added = await mutateProcess({
      id: created.id,
      lockToken: created.lockToken ?? "",
      expectedRevision: created.revision,
      ops: [
        {
          op: "add",
          type: "serviceTask",
          ref: "charge",
          name: "Charge card",
          properties: { class: "com.example.ChargeCardDelegate" },
        },
        { op: "connect", sourceId: "StartEvent_1", targetId: "charge" },
        {
          op: "add",
          type: "boundaryEvent",
          ref: "timeout",
          name: "Timed out",
          attachToId: "charge",
          eventDefinition: { type: "timer", timerDuration: "PT2H" },
        },
      ],
    });

    expect(added.xml).toContain('camunda:class="com.example.ChargeCardDelegate"');
    expect(added.xml).toContain("PT2H");
    const bounds = added.xml.match(/id="StartEvent_1_di"[\s\S]*?<dc:Bounds[^>]*\/>/)?.[0];

    const renamed = await editDiagram(added.xml, [
      { op: "update", elementId: "StartEvent_1", name: "Begin" },
    ]);
    expect(renamed.xml).toContain('name="Begin"');
    expect(renamed.xml).toContain(bounds ?? "missing-bounds");
  });

  test("rejects a terminate definition on a start event", async () => {
    const created = await createProcess({ name: "Bad event" });
    await expect(
      editDiagram(created.xml, [
        { op: "add", type: "startEvent", name: "Again", eventDefinition: { type: "terminate" } },
      ]),
    ).rejects.toThrow(/not allowed/);
  });
});

describe("locks and http", () => {
  test("an agent lock blocks the user until it is the current revision", async () => {
    const created = await createProcess({ name: "Shared", lockForAgent: true });
    await expect(saveUserXml(created.id, created.xml, created.revision)).rejects.toThrow(/agent is editing/);
    await expect(acquireLock(created.id)).rejects.toThrow(/already locked/);

    const moved = await mutateProcess({
      id: created.id,
      lockToken: created.lockToken ?? "",
      expectedRevision: created.revision,
      ops: [{ op: "add", type: "userTask", ref: "review", name: "Review", properties: { assignee: "demo" } },
        { op: "connect", sourceId: "StartEvent_1", targetId: "review" }],
    });
    await expect(
      mutateProcess({
        id: created.id,
        lockToken: created.lockToken ?? "",
        expectedRevision: created.revision,
        ops: [{ op: "update", elementId: moved.refs.review ?? "", name: "Review again" }],
      }),
    ).rejects.toThrow(/revision/i);
  });

  test("creates and reads a process over HTTP", async () => {
    const app = createApp();
    const created = await app.request("/api/processes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Onboarding" }),
    });
    expect(created.status).toBe(201);
    const body = await created.json() as { id: string; xml: string };
    expect(body.xml).toContain("isExecutable=\"true\"");

    const listed = await app.request("/api/processes");
    const rows = await listed.json() as { id: string }[];
    expect(rows.some((row) => row.id === body.id)).toBe(true);

    const validated = await app.request(`/api/processes/${body.id}/validate`, { method: "POST", body: "{}" });
    expect(validated.status).toBe(200);
    const report = await validated.json() as { issues: { severity: string }[] };
    expect(report.issues.some((issue) => issue.severity === "error")).toBe(true);
  });
});
